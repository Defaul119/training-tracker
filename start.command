#!/bin/zsh
# Double-click this file to start the dashboard. Close the window to stop it.
cd "$(dirname "$0")" && exec /usr/bin/python3 server.py --open
