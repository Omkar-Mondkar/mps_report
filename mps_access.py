#!/usr/bin/env python3
"""Manage MPS dashboard access from the host: users, roles, groups, grants, audit.
See auth/cli.py or run with --help."""
import sys

from auth.cli import main

if __name__ == '__main__':
    sys.exit(main())