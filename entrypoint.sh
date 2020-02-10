#!/bin/bash
set -Eeuo pipefail

COMMAND=$1

cd /app
mkdir -p /downloads/normalized
case $COMMAND in
  "web")
    npm start
  ;;
  "task-runner")
    npm run start:task-runner
  ;;
esac

exit $?
