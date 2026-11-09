# The Ask your data chat relay: copilot/server.py in relay mode, built in Azure by copilot/deploy.py from a context that
# holds copilot/*.py, copilot/requirements.txt, the US state shapes the Vega-Lite check uses, and the place and hospital
# location files copilot/geo.py reads.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    COPILOT_CLI_EXTRACT_DIR=/opt/copilot-runtime \
    COPILOT_WORK_DIR=/home/relay/work \
    RELAY=1 \
    PORT=8080

RUN useradd --create-home --uid 10001 relay
WORKDIR /app
COPY copilot/requirements.txt copilot/requirements.txt
# The Copilot runtime is downloaded at build time so the container starts without fetching it
RUN pip install --no-cache-dir -r copilot/requirements.txt \
    && python -m copilot download-runtime \
    && chown -R relay /opt/copilot-runtime
COPY assets/vendor/vega/us-states-10m.json assets/vendor/vega/
# Places, ZIP centres and geocoded hospitals for nearest_care, nearby_hospitals and route_care (copilot/geo.py), with the
# dashboard's hospital names and maternity care for when the model can't be reached
COPY assets/places.js assets/zip-centroids.js assets/hospital-locations.js assets/maternity.js assets/data.js assets/
COPY copilot/*.py copilot/

USER relay
EXPOSE 8080
CMD ["python", "copilot/server.py"]
