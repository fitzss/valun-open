# Valun hosted demo: the Valun web app + the real Basis tracker (pure-credit, loopback-only) in one container.
# dist/bin holds Linux builds made offline in WSL valun-ic1 from the pinned Basis source (see basis/BUILD.md);
# they need glibc >= 2.38, hence a Debian trixie base.
FROM node:24-trixie-slim

RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin valun \
 && mkdir -p /opt/valun/bin /opt/valun/app /data && chown valun:valun /data

COPY --chmod=0755 dist/bin/basis_server dist/bin/valun_signer /opt/valun/bin/
COPY --chmod=0755 basis/run-tracker.sh scripts/docker-entrypoint.sh /opt/valun/
COPY package.json server.mjs /opt/valun/app/
COPY lib /opt/valun/app/lib
COPY public /opt/valun/app/public
COPY test /opt/valun/app/test
COPY basis/run-tracker.sh /opt/valun/app/basis/run-tracker.sh
COPY scripts/check-persistence.mjs scripts/check-exposure.mjs scripts/valun-mcp-stdio.mjs scripts/pilot-admin.mjs scripts/pilot-downgrade-check.mjs /opt/valun/app/scripts/

# Starts as root only to chown the mounted volume, then drops to 'valun' (see docker-entrypoint.sh).
# VALUN_APP_COPY=image marks this app folder as the image's copy (only the files above): a test that needs another file
# of the repository is skipped here (test/operations.test.mjs); scripts/rehearse-container.mjs sets the same marker.
WORKDIR /opt/valun/app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 \
    BASIS_RUNNER=direct BASIS_SIGNER=/opt/valun/bin/valun_signer VALUN_BINS=/opt/valun/bin \
    BASIS_TRACKER_URL=http://127.0.0.1:3048 VALUN_DATA_DIR=/data/valun VALUN_DEPLOYMENT=hosted VALUN_APP_COPY=image
EXPOSE 8080
ENTRYPOINT ["/opt/valun/docker-entrypoint.sh"]
