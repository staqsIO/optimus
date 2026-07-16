#!/bin/bash
# Satellite runner for Jamie's M1 Mac.
# Runs ONLY the Claude-CLI agents (executor-redesign + executor-coder + executor-blueprint).
# All other agents run on Railway.
AGENTS_ENABLED=executor-redesign,executor-coder,executor-blueprint exec npm start
