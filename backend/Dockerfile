FROM python:3.12-slim

WORKDIR /app
# ffmpeg cho time-stretch audio (atempo) trong auto-test
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

EXPOSE 8077
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8077"]
