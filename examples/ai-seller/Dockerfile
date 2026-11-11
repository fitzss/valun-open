# The Valun AI seller (ai_seller.py) in one small container: Python, the published valun client and the official
# Anthropic SDK, both pinned. Profiles (each agent's key), owner tokens and the budget file live on the /data volume.
FROM python:3.12-slim

RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin seller && mkdir -p /app /data
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY ai_seller.py entrypoint.sh ./
RUN chmod 0755 entrypoint.sh
ENV VALUN_HOME=/data/valun PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["/app/entrypoint.sh"]
