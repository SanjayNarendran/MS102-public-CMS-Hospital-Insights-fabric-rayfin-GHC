#!/usr/bin/env python3
"""Deploys Ask your data to Fabric: the GitHub Copilot relay (an Azure Container App running copilot/server.py with
RELAY=1) and the dashboard's Fabric App with its Rayfin Functions (chatTicket, dax).

    python3 copilot/deploy.py create              # once: the Azure resources, the Container App and its chat ticket
                                                  # key; prints the GitHub OAuth App steps
    python3 copilot/deploy.py configure CLIENT_ID # once, after the GitHub OAuth App: the relay's settings and CORS
    python3 copilot/deploy.py relay               # build the relay image in Azure, roll the Container App, /healthz
    python3 copilot/deploy.py app                 # the chat lakehouse, the functions' config and dependencies, Rayfin
                                                  # Data and Functions switched on in rayfin.yml, the CHAT_TICKET_KEY
                                                  # secret, then rayfin up
    python3 copilot/deploy.py status

Needs `az login` to an Azure subscription where you can create a resource group, a Container Apps environment and a
container registry (`create` makes any that are missing), and CMS_WORKSPACE_ID: the Fabric workspace with the CMS and
CMS V2 semantic models (publish_fabric.py). `create` and `configure` need the dashboard deployed to Fabric once
(`npx rayfin up` in fabric-app/, see AGENTS.md). `app` needs Node 20, 22 or 24 for the
Rayfin CLI and the Fabric capacity behind the app running. The GitHub OAuth App's client secret is stored by the person,
never by this script (AGENTS.md, "Ask your data in Fabric"). Secrets are never printed.

Names, all optional (environment variables):
    CMS_CHAT_RESOURCE_GROUP  rg-cms-quality-chat      CMS_CHAT_LOCATION   eastus (for anything created)
    CMS_CHAT_ENVIRONMENT     cms-quality-chat-env     CMS_CHAT_REGISTRY   cmsqualitychat + 8 characters of the
    CMS_CHAT_CONTAINER_APP   cms-quality-chat                             subscription ID (registry names are global)
    CMS_CHAT_LAKEHOUSE       lh_cms_chats             RAYFIN_NODE_BIN     a folder with Node 20, 22 or 24, if the
                                                                          default node is another version
"""
import argparse
import functools
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FABRIC_APP = ROOT / "fabric-app"
sys.path.insert(0, str(HERE))
import fabric  # noqa: E402

RG = os.environ.get("CMS_CHAT_RESOURCE_GROUP", "rg-cms-quality-chat")
LOCATION = os.environ.get("CMS_CHAT_LOCATION", "eastus")
ENVIRONMENT = os.environ.get("CMS_CHAT_ENVIRONMENT", "cms-quality-chat-env")
APP = os.environ.get("CMS_CHAT_CONTAINER_APP", "cms-quality-chat")
IMAGE = "cms-quality-chat"
TAGS = "project=cms-quality-dashboard"
DEFAULT_MODEL, DEFAULT_EFFORT = "claude-opus-5.5", "high"
NODE = os.environ.get("RAYFIN_NODE_BIN", "")
RELAY_ASSETS = ("places.js", "zip-centroids.js", "hospital-locations.js", "maternity.js", "data.js")   # copilot/geo.py


def az(*args, capture=True, check=True):
    r = subprocess.run(["az", *args], capture_output=capture, text=True)
    if check and r.returncode:
        raise SystemExit(f"az {' '.join(args[:3])} failed: {(r.stderr or '').strip()[-800:]}")
    return (r.stdout or "").strip()


@functools.cache
def registry():
    """CMS_CHAT_REGISTRY, else a name made from the subscription, so it is the same on every run and unlikely to clash."""
    name = os.environ.get("CMS_CHAT_REGISTRY", "").strip()
    if name:
        return name
    sub = az("account", "show", "--query", "id", "-o", "tsv")
    return "cmsqualitychat" + hashlib.sha256(sub.encode()).hexdigest()[:8]


def ensure_cli():
    """The Azure CLI's containerapp extension, installed without a prompt (a prompt would hang with captured output)."""
    if not shutil.which("az"):
        raise SystemExit("Install the Azure CLI and run `az login` first.")
    if not az("extension", "show", "-n", "containerapp", "--query", "name", "-o", "tsv", check=False):
        print("Installing the Azure CLI extension containerapp", flush=True)
        az("extension", "add", "-n", "containerapp", "--yes", "--only-show-errors", "-o", "none")


def ensure_azure():
    """The resource group, Container Apps environment and container registry: kept if they exist, created if not."""
    for ns in ("Microsoft.App", "Microsoft.ContainerRegistry"):
        if az("provider", "show", "-n", ns, "--query", "registrationState", "-o", "tsv") != "Registered":
            print(f"Registering the resource provider {ns} (a minute or two)", flush=True)
            az("provider", "register", "-n", ns, "--wait", "-o", "none")
    if az("group", "exists", "-n", RG) != "true":
        az("group", "create", "-n", RG, "-l", LOCATION, "--tags", TAGS, "-o", "none")
        print(f"Created the resource group {RG} in {LOCATION}")
    location = az("group", "show", "-n", RG, "--query", "location", "-o", "tsv")
    if not az("containerapp", "env", "show", "-g", RG, "-n", ENVIRONMENT, "--query", "name", "-o", "tsv", check=False):
        print(f"Creating the Container Apps environment {ENVIRONMENT} (a few minutes)", flush=True)
        az("containerapp", "env", "create", "-g", RG, "-n", ENVIRONMENT, "-l", location, "--logs-destination", "none",
           "--tags", TAGS, "-o", "none")
    if not az("acr", "show", "-n", registry(), "--query", "name", "-o", "tsv", check=False):
        az("acr", "create", "-g", RG, "-n", registry(), "-l", location, "--sku", "Basic", "--tags", TAGS, "-o", "none")
        print(f"Created the container registry {registry()}")


def app_exists():
    return bool(az("containerapp", "list", "-g", RG, "--query", f"[?name=='{APP}'].name", "-o", "tsv"))


def fqdn():
    return az("containerapp", "show", "-g", RG, "-n", APP, "--query", "properties.configuration.ingress.fqdn", "-o", "tsv")


def app_origin():
    """The Fabric App's address, from the active Rayfin deployment (fabric-app/rayfin/.deployments.json)."""
    path = FABRIC_APP / "rayfin" / ".deployments.json"
    if not path.exists():
        raise SystemExit("fabric-app/rayfin/.deployments.json is missing: deploy the dashboard once with "
                         "`npx rayfin up` in fabric-app/ (AGENTS.md).")
    d = json.loads(path.read_text())
    return d["deployments"][d["active"]]["hostingUrl"].rstrip("/")


def secret_names():
    return {s["name"] for s in json.loads(az("containerapp", "secret", "list", "-g", RG, "-n", APP, "-o", "json") or "[]")}


def wait_ready():
    """Waits while another update of the Container App is in progress (concurrent updates fail)."""
    for _ in range(60):
        if az("containerapp", "show", "-g", RG, "-n", APP, "--query", "properties.provisioningState", "-o", "tsv") != "InProgress":
            return
        time.sleep(10)
    raise SystemExit(f"{APP} is still updating; try again later")


def create():
    origin = app_origin()
    ensure_azure()
    if not app_exists():
        az("containerapp", "create", "-g", RG, "-n", APP, "--environment", ENVIRONMENT,
           "--image", "mcr.microsoft.com/k8se/quickstart:latest", "--ingress", "external", "--target-port", "80",
           "--cpu", "1", "--memory", "2Gi", "--min-replicas", "0", "--max-replicas", "1",
           "--tags", TAGS, "-o", "none")
        print(f"Created the Container App {APP} in {ENVIRONMENT}")
    wait_ready()
    if "chat-ticket-key" not in secret_names():  # generated here and never shown
        az("containerapp", "secret", "set", "-g", RG, "-n", APP, "--secrets", f"chat-ticket-key={secrets.token_urlsafe(32)}", "-o", "none")
        print("Stored a new chat ticket key in the Container App (secret chat-ticket-key)")
    host = fqdn()
    print(f"""
Relay address: https://{host}

Next, the GitHub OAuth App (once, by you, on github.com):
  Settings → Developer settings → OAuth Apps → New OAuth App
    Application name            Hospital Quality, Ask your data
    Homepage URL                {origin}
    Authorization callback URL  https://{host}/auth/github/callback
  Register it, note the Client ID, then generate a client secret and store it yourself:
    read -rs GH_SECRET   # paste the secret, press Enter
    az containerapp secret set -g {RG} -n {APP} --secrets github-client-secret="$GH_SECRET" -o none; unset GH_SECRET
Then: python3 copilot/deploy.py configure <client-id>""")


def configure(client_id):
    if "github-client-secret" not in secret_names():
        raise SystemExit(f"Store the GitHub client secret first: az containerapp secret set -g {RG} -n {APP} --secrets github-client-secret=...")
    origin, host = app_origin(), fqdn()
    origins = [origin, "http://127.0.0.1:5173", "http://localhost:5173"]
    wait_ready()
    az("containerapp", "update", "-g", RG, "-n", APP, "-o", "none", "--set-env-vars",
       f"GITHUB_CLIENT_ID={client_id}", "GITHUB_CLIENT_SECRET=secretref:github-client-secret",
       "CHAT_TICKET_KEY=secretref:chat-ticket-key", f"ALLOWED_ORIGIN={','.join(origins)}", f"PUBLIC_URL=https://{host}",
       "RELAY=1", f"CMS_MODEL={DEFAULT_MODEL}", f"CMS_EFFORT={DEFAULT_EFFORT}")
    wait_ready()
    az("containerapp", "ingress", "cors", "enable", "-g", RG, "-n", APP, "-o", "none", "--allowed-origins", *origins,
       "--allowed-methods", "GET", "POST", "OPTIONS", "--allowed-headers", "content-type", "x-chat-ticket", "--max-age", "3600")
    print(f"Configured {APP}: GitHub client {client_id}, CORS for {origin}")


def use_registry(server):
    """Lets the Container App pull from the registry with its admin credential, kept as the secret acr-password."""
    current = json.loads(az("containerapp", "show", "-g", RG, "-n", APP, "--query", "properties.configuration.registries", "-o", "json") or "[]")
    if any(r.get("server") == server for r in current):
        return
    az("acr", "update", "-n", registry(), "--admin-enabled", "true", "-o", "none")
    creds = json.loads(az("acr", "credential", "show", "-n", registry(), "-o", "json"))
    wait_ready()
    az("containerapp", "registry", "set", "-g", RG, "-n", APP, "--server", server, "--username", creds["username"],
       "--password", creds["passwords"][0]["value"], "-o", "none")
    print(f"The Container App pulls from {server}")


def build_image(server, tag, ctx):
    """Builds the image with ACR Tasks, or with the local Docker where the subscription doesn't allow ACR Tasks."""
    r = subprocess.run(["az", "acr", "build", "-r", registry(), "-t", f"{IMAGE}:{tag}", "-t", f"{IMAGE}:latest",
                        "--platform", "linux/amd64", "-f", "copilot/Dockerfile", "--no-logs", str(ctx)],
                       capture_output=True, text=True)
    if not r.returncode:
        return
    if "TasksOperationsNotAllowed" not in r.stderr or not shutil.which("docker"):
        raise SystemExit(f"az acr build failed: {r.stderr.strip()[-800:]}")
    print("ACR Tasks are not allowed in this subscription: building with the local Docker instead", flush=True)
    subprocess.run(["docker", "build", "--platform", "linux/amd64", "-f", str(ctx / "copilot" / "Dockerfile"),
                    "-t", f"{server}/{IMAGE}:{tag}", str(ctx)], check=True)
    az("acr", "login", "-n", registry())
    subprocess.run(["docker", "push", f"{server}/{IMAGE}:{tag}"], check=True)


def relay():
    missing = [f for f in (*RELAY_ASSETS, "vendor/vega/us-states-10m.json") if not (ROOT / "assets" / f).exists()]
    if missing:
        raise SystemExit(f"assets/{missing[0]} is missing: build the data first (python3 build_all.py).")
    server = az("acr", "show", "-n", registry(), "--query", "loginServer", "-o", "tsv")
    tag = time.strftime("%Y%m%d-%H%M%S")
    with tempfile.TemporaryDirectory() as ctx:  # only what the image needs
        ctx = Path(ctx)
        (ctx / "copilot").mkdir()
        for f in [*HERE.glob("*.py"), HERE / "requirements.txt", HERE / "Dockerfile"]:
            shutil.copy(f, ctx / "copilot" / f.name)
        (ctx / "assets" / "vendor" / "vega").mkdir(parents=True)
        shutil.copy(ROOT / "assets" / "vendor" / "vega" / "us-states-10m.json", ctx / "assets" / "vendor" / "vega")
        for f in RELAY_ASSETS:
            shutil.copy(ROOT / "assets" / f, ctx / "assets" / f)
        print(f"Building {server}/{IMAGE}:{tag} in Azure (a few minutes)", flush=True)
        build_image(server, tag, ctx)
    use_registry(server)
    wait_ready()
    az("containerapp", "update", "-g", RG, "-n", APP, "--image", f"{server}/{IMAGE}:{tag}", "-o", "none")
    wait_ready()
    az("containerapp", "ingress", "update", "-g", RG, "-n", APP, "--target-port", "8080", "-o", "none")
    url = f"https://{fqdn()}"
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"{url}/healthz", timeout=60) as r:
                if json.load(r).get("mode") == "relay":
                    print(f"Relay is up: {url}")
                    return
        except Exception:
            time.sleep(10)
    raise SystemExit(f"{url}/healthz did not answer")


def node_env():
    env = {**os.environ, "PATH": f"{NODE}:{os.environ.get('PATH', '')}"} if NODE else dict(os.environ)
    v = subprocess.run(["node", "-v"], capture_output=True, text=True, env=env).stdout.strip()
    if not v.startswith(("v20.", "v22.", "v24.")):
        raise SystemExit(f"The Rayfin CLI needs Node 20, 22 or 24 (found {v or 'none'}); set RAYFIN_NODE_BIN.")
    return env


CHAT_LAKEHOUSE = os.environ.get("CMS_CHAT_LAKEHOUSE", "lh_cms_chats")


def app_workspace():
    """The Fabric App's workspace, from the Rayfin deployment (fabric-app/rayfin/.env)."""
    env = FABRIC_APP / "rayfin" / ".env"
    for line in env.read_text().splitlines() if env.exists() else []:
        if line.startswith("RAYFIN_PUBLIC_WORKSPACE_ID="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("fabric-app/rayfin/.env has no RAYFIN_PUBLIC_WORKSPACE_ID: deploy the dashboard once with `npx rayfin up`.")


def chat_lakehouse():
    """The lakehouse that keeps saved answers (chatPayload), in the app's workspace: found, or created once."""
    ws = app_workspace()
    token = az("account", "get-access-token", "--resource", "https://api.fabric.microsoft.com", "--query", "accessToken", "-o", "tsv")
    def call(method, path, body=None):
        req = urllib.request.Request(f"https://api.fabric.microsoft.com/v1{path}", method=method,
                                     data=json.dumps(body).encode() if body else None,
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"{}"), r.status, r.headers
    items, _, _ = call("GET", f"/workspaces/{ws}/lakehouses")
    found = next((x for x in items.get("value", []) if x.get("displayName") == CHAT_LAKEHOUSE), None)
    if not found:
        found, status, headers = call("POST", f"/workspaces/{ws}/lakehouses",
                                      {"displayName": CHAT_LAKEHOUSE, "description": "Ask your data: saved answers"})
        for _ in range(30):  # 202: provisioning; poll the list until it shows up
            if found.get("id"):
                break
            time.sleep(5)
            items, _, _ = call("GET", f"/workspaces/{ws}/lakehouses")
            found = next((x for x in items.get("value", []) if x.get("displayName") == CHAT_LAKEHOUSE), {})
        print(f"Created the lakehouse {CHAT_LAKEHOUSE}")
    return ws, found["id"]


CHAT_SERVICES = ("data", "functions")


def enable_chat_services():
    """Switches on Rayfin Data (saved chats) and Rayfin Functions in rayfin.yml; the committed file has them off so a
    dashboard-only deploy creates neither."""
    path = FABRIC_APP / "rayfin" / "rayfin.yml"
    lines, section, changed = path.read_text().splitlines(keepends=True), None, False
    for i, line in enumerate(lines):
        if line.startswith("  ") and not line.startswith("   ") and line.strip().endswith(":"):
            section = line.strip()[:-1]
        elif not line.startswith(" "):
            section = None
        elif section in CHAT_SERVICES and line.strip() == "enabled: false" and line.startswith("    ") and not line.startswith("     "):
            lines[i], changed = line.replace("false", "true"), True
    if changed:
        path.write_text("".join(lines))
        print("Switched on Rayfin Data and Functions in fabric-app/rayfin/rayfin.yml")


def install_functions(env):
    """The functions project's own dependencies (fabric-app/rayfin/functions has its own package.json)."""
    folder = FABRIC_APP / "rayfin" / "functions"
    if not (folder / "node_modules" / "@microsoft" / "fabric-user-data-functions").exists():
        print("Installing the Rayfin Functions' dependencies (npm ci)", flush=True)
        subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=folder, env=env, check=True)


def app():
    host = fqdn()
    try:
        fabric.model_id("CMS"), fabric.model_id("CMS V2")
    except fabric.DaxError as e:
        raise SystemExit(str(e)) from None
    chat_ws, chat_lh = chat_lakehouse()
    config = FABRIC_APP / "rayfin" / "functions" / "src" / "config.generated.ts"
    config.write_text("// Written by copilot/deploy.py for this deployment.\nexport const CONFIG = " + json.dumps({
        "workspaceId": fabric.workspace(), "cmsModelId": fabric.model_id("CMS"), "cmsV2ModelId": fabric.model_id("CMS V2"),
        "chatUrl": f"https://{host}", "chatWorkspaceId": chat_ws, "chatLakehouseId": chat_lh}, indent=2) + " as const;\n")
    print(f"Wrote {config.relative_to(ROOT)}")
    env = node_env()
    enable_chat_services()
    install_functions(env)
    key = az("containerapp", "secret", "show", "-g", RG, "-n", APP, "--secret-name", "chat-ticket-key", "--query", "value", "-o", "tsv")
    r = subprocess.run(["npx", "rayfin", "secret", "set", "CHAT_TICKET_KEY", "--stdin",
                        "--describe=Signs the chat tickets that Ask your data sends to the GitHub Copilot relay"],
                       input=key + "\n", cwd=FABRIC_APP, env=env, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("rayfin secret set failed: " + (r.stdout + r.stderr).strip()[-1500:])
    print("Set the Rayfin secret CHAT_TICKET_KEY")
    subprocess.run(["npx", "rayfin", "up"], cwd=FABRIC_APP, env=env, check=True)


def status():
    if not app_exists():
        print(f"No Container App {APP} in {RG}: run `python3 copilot/deploy.py create`.")
        return
    url = f"https://{fqdn()}"
    print(f"Resource group {RG}, environment {ENVIRONMENT}, registry {registry()}")
    print(f"Relay: {url}  secrets: {sorted(secret_names())}")
    try:
        with urllib.request.urlopen(f"{url}/healthz", timeout=60) as r:
            print("healthz:", r.read().decode())
    except Exception as e:
        print("healthz:", e)
    print("Fabric App:", app_origin())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["create", "configure", "relay", "app", "status"])
    parser.add_argument("client_id", nargs="?")
    args = parser.parse_args()
    ensure_cli()
    if args.command == "configure":
        if not args.client_id:
            raise SystemExit("Give the GitHub OAuth App's client ID: python3 copilot/deploy.py configure <client-id>")
        configure(args.client_id)
    else:
        {"create": create, "relay": relay, "app": app, "status": status}[args.command]()
