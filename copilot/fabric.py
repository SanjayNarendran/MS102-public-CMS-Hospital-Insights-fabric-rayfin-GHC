"""DAX on the two semantic models behind the dashboard, CMS and CMS V2, as published by publish_fabric.py.

The workspace comes from CMS_WORKSPACE_ID (or FABRIC_WORKSPACE_ID, as for publish_fabric.py). The models are found in it
by name; CMS_DATASET_ID and CMS_V2_DATASET_ID override the lookup.

Locally, queries go to the Power BI executeQueries API with the signed-in az CLI account. In the relay (the Fabric-
hosted chat), the relay has no Fabric access: each query is handed to the page, which runs it through the dashboard's
`dax` Rayfin Function. Tools always call `dax()`; the server picks the runner per chat with `use_runner()`."""
import contextvars
import json
import os
import shutil
import subprocess
import time

import httpx

WORKSPACE = (os.environ.get("CMS_WORKSPACE_ID") or os.environ.get("FABRIC_WORKSPACE_ID") or "").strip()
MODEL_ENV = {"CMS": "CMS_DATASET_ID", "CMS V2": "CMS_V2_DATASET_ID"}
SUBSCRIPTION = os.environ.get("CMS_AZ_SUBSCRIPTION", "")  # picks the tenant for `az account get-access-token`


class DaxError(Exception):
    pass


def model_name(model) -> str:
    """'CMS' or 'CMS V2' from what the model wrote ('cms v2', 'CMS_V2', 'v2' ...)."""
    key = str(model or "CMS").strip().upper().replace("_", " ").replace("-", " ")
    if key in ("V2", "CMSV2", "CMS V2"):
        return "CMS V2"
    if key == "CMS":
        return "CMS"
    raise DaxError(f"Unknown model {model!r}: use 'CMS' (HAI, HCAHPS, PSI90) or 'CMS V2' (outcomes and maternity).")


def plain_rows(rows):
    """executeQueries rows with 'Table'[column] keys shortened to the column name."""
    return [{(k.split("[", 1)[1].rstrip("]") if "[" in k else k): v for k, v in row.items()} for row in rows]


# --- local: the az CLI sign-in -------------------------------------------------------------------------------------
_token = {"value": None, "exp": 0.0}


def _az_token():
    if _token["value"] and time.time() < _token["exp"] - 300:
        return _token["value"]
    cmd = [shutil.which("az") or "az", "account", "get-access-token", "--resource",
           "https://analysis.windows.net/powerbi/api", "-o", "json"]
    if SUBSCRIPTION:
        cmd[3:3] = ["--subscription", SUBSCRIPTION]
    try:
        out = json.loads(subprocess.check_output(cmd, text=True, stderr=subprocess.PIPE))
    except subprocess.CalledProcessError as e:
        raise DaxError(f"az could not get a Power BI token ({(e.stderr or '').strip()[-300:]}). Run `az login`.") from None
    _token.update(value=out["accessToken"], exp=float(out.get("expires_on") or time.time() + 3000))
    return _token["value"]


_model_ids: dict = {}


def workspace() -> str:
    if not WORKSPACE:
        raise DaxError("Set CMS_WORKSPACE_ID to the Fabric workspace that holds the CMS and CMS V2 semantic models "
                       "(published with publish_fabric.py), then restart the chat server.")
    return WORKSPACE


def model_id(name: str) -> str:
    """The ID of semantic model 'CMS' or 'CMS V2': from CMS_DATASET_ID / CMS_V2_DATASET_ID, else found by name."""
    name = model_name(name)
    if name in _model_ids:
        return _model_ids[name]
    found = os.environ.get(MODEL_ENV[name], "").strip()
    if not found:
        r = httpx.get(f"https://api.powerbi.com/v1.0/myorg/groups/{workspace()}/datasets",
                      headers={"Authorization": f"Bearer {_az_token()}"}, timeout=60)
        if r.status_code != 200:
            raise DaxError(f"Could not list the semantic models in workspace {WORKSPACE}: {error_text(r.status_code, r.text)}")
        found = next((d["id"] for d in r.json().get("value", []) if d.get("name") == name), "")
        if not found:
            raise DaxError(f"Workspace {WORKSPACE} has no semantic model named {name!r}: publish it with publish_fabric.py.")
    _model_ids[name] = found
    return found


def az_dax(query: str, model: str):
    url = f"https://api.powerbi.com/v1.0/myorg/groups/{workspace()}/datasets/{model_id(model)}/executeQueries"
    for attempt in range(3):
        r = httpx.post(url, headers={"Authorization": f"Bearer {_az_token()}"}, timeout=120,
                       json={"queries": [{"query": query}], "serializerSettings": {"includeNulls": True}})
        if r.status_code != 429 and r.status_code < 500:
            break
        time.sleep(3 * (attempt + 1))
    if r.status_code != 200:
        raise DaxError(error_text(r.status_code, r.text))
    return plain_rows(r.json()["results"][0]["tables"][0].get("rows", []))


def error_text(status: int, text: str) -> str:
    """The DAX error message from an executeQueries failure, or a hint when the capacity is paused."""
    try:
        body = json.loads(text)
        err = body.get("error") or {}
        detail = (err.get("pbi.error") or {}).get("details") or []
        if detail:
            return detail[0]["detail"]["value"]
        if err.get("code") in ("CapacityNotActive", "Capacity_Not_Active") or "capacity" in json.dumps(err).lower():
            return "The Fabric capacity behind the CMS models is paused; resume it and ask again."
        return err.get("message") or text[:800]
    except (ValueError, KeyError, TypeError, IndexError):
        return f"HTTP {status}: {text[:800]}"


# --- the runner for this chat ----------------------------------------------------------------------------------------
_runner: contextvars.ContextVar = contextvars.ContextVar("dax_runner", default=None)


def use_runner(runner):
    """Sets the DAX runner (query, model) -> rows for the current context; tools run in a copy of it."""
    _runner.set(runner)


def dax(query: str, model: str = "CMS"):
    """Runs one DAX query on 'CMS' or 'CMS V2' and returns plain row dicts. Raises DaxError."""
    if not isinstance(query, str) or not query.strip():
        raise DaxError("Empty DAX query.")
    return (_runner.get() or az_dax)(query, model_name(model))
