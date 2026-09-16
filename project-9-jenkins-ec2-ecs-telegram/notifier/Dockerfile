# The "different language" container in project-9 — every other service in this repo
# is Node (see apps/*/Dockerfile); this one is Python, deliberately, to demonstrate the
# Jenkinsfile building images across languages in the same pipeline.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY status_notifier.py .

RUN mkdir -p /data
VOLUME ["/data"]

# No HTTP server - this is a polling loop, not a request handler. A container
# healthcheck just confirms the process is still alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD pgrep -f status_notifier.py || exit 1

CMD ["python", "status_notifier.py"]
