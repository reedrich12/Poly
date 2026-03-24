"""
Configuration settings for the Polymarket Volatility Engine.
"""
from typing import List

# The specific tags/categories to pull from the Gamma API
# These correspond to: /iran, /geopolitics, /finance/indicies, etc.
TARGET_CATEGORIES: List[str] = [
    "iran", 
    "geopolitics", 
    "indices", 
    "commodities", 
    "forex", 
    "fed-rates", 
    "treasuries"
]

# --- Volatility Math Parameters ---

# Number of recent trades to keep in memory for the baseline average
ROLLING_WINDOW_SIZE: int = 100  

# The standard deviation multiplier that triggers an alert (3.0 is a standard statistical anomaly)
Z_SCORE_THRESHOLD: float = 3.0  

# Minimum number of trades needed in the window before we start calculating anomalies 
# (Prevents false positives on newly opened markets)
MIN_DATA_POINTS: int = 10  
