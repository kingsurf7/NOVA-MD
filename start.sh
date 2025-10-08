#!/bin/bash
npm install --omit=dev
python3 bot.py &
node index.js
