#!/bin/bash
cd /home/kavia/workspace/code-generation/video-to-audio-converter-203348-203357/frontend_react
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

