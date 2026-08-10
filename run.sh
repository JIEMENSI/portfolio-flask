#!/bin/bash
export PYTHONPATH=/root/.local/lib/python3.12/site-packages:$PYTHONPATH
cd "$(dirname "$0")"
python3 app.py
