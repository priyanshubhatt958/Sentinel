import os
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), 'models')
os.makedirs(OUTPUT_DIR, exist_ok=True)

np.random.seed(42)
feature_columns = ['cpuUsage', 'memoryUsage', 'requestRate', 'latencyMs', 'errorRate', 'dbConnections']

normal_rows = []
for _ in range(500):
    normal_rows.append({
        'cpuUsage': np.random.uniform(0, 60),
        'memoryUsage': np.random.uniform(0.1, 70),
        'requestRate': np.random.uniform(0, 300),
        'latencyMs': np.random.uniform(1, 250),
        'errorRate': np.random.uniform(0, 2.0),
        'dbConnections': np.random.uniform(0, 35),
    })

training_df = pd.DataFrame(normal_rows, columns=feature_columns)
model = IsolationForest(contamination=0.05, random_state=42)
model.fit(training_df)

model_path = os.path.join(OUTPUT_DIR, 'isolation_forest.joblib')
joblib.dump(model, model_path)
print(f'Trained model saved to {model_path}')
