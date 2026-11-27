FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY train_model.py ./train_model.py
COPY models ./models
RUN python train_model.py
COPY tests ./tests
RUN python -m unittest discover -s tests

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
