FROM python:3.12-slim
WORKDIR /app
COPY lookup_service.py .
# The lookup store (biz_lookup.db, ~7 GB) is NOT baked into the image.
# Mount it on a persistent disk / volume and point BIZ_LOOKUP_DB at it.
ENV BIZ_LOOKUP_DB=/data/biz_lookup.db
ENV PORT=8090
EXPOSE 8090
CMD ["python", "lookup_service.py"]
