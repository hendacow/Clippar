#!/bin/bash
# Start Clippar server + tunnel on login
cd /Users/hendacow/projects/final_shipment

# Activate venv and start Flask in background
source .venv/bin/activate
python app.py &
FLASK_PID=$!

# Wait for Flask to start
sleep 2

# Start SSH tunnel
ssh -R 80:localhost:5050 localhost.run &
TUNNEL_PID=$!

echo "Clippar running — Flask PID: $FLASK_PID, Tunnel PID: $TUNNEL_PID"
echo "Press Ctrl+C to stop both"

# Trap Ctrl+C to kill both
trap "kill $FLASK_PID $TUNNEL_PID 2>/dev/null; exit" INT TERM
wait
