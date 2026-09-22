"""Verify real Compose interpolation without starting containers or using secrets."""

import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
DEFAULTS = {
    "MAX_CONCURRENT_SESSIONS": "5",
    "LIVE_SESSION_LEASE_MS": "900000",
    "LIVE_SESSION_RATE_LIMIT": "20",
    "LIVE_SESSION_RATE_WINDOW_MS": "600000",
}


def resolve_compose(overrides):
    env = os.environ.copy()
    for name in DEFAULTS:
        env.pop(name, None)
    env.update({
        "OPENAI_API_KEY": "compose-test-placeholder-not-a-real-key",
        "WEB_ORIGIN": "https://translator.example.test",
        "API_BIND_PORT": "13001",
        "WEB_BIND_PORT": "18081",
        "COMPOSE_DISABLE_ENV_FILE": "1",
    })
    env.update(overrides)
    result = subprocess.run(
        ["docker", "compose", "--env-file", os.devnull,
         "-f", "infra/docker-compose.yml", "config", "--format", "json"],
        cwd=ROOT, env=env, text=True, capture_output=True, check=True, timeout=30,
    )
    return json.loads(result.stdout)["services"]


class AdmissionComposeTests(unittest.TestCase):
    def check_api_only(self, services, expected):
        api_env = services["api"]["environment"]
        self.assertEqual({name: api_env.get(name) for name in DEFAULTS}, expected)
        protected = set(DEFAULTS) | {"OPENAI_API_KEY"}
        for service in services.values():
            # Admission settings and secrets are runtime-only, never build args.
            self.assertTrue(protected.isdisjoint(service.get("build", {}).get("args", {})))
        self.assertTrue(protected.isdisjoint(services["web"].get("environment", {})))

    def test_absent_variables_keep_safe_defaults(self):
        self.check_api_only(resolve_compose({}), DEFAULTS)

    def test_explicit_internal_profile_and_timing_overrides(self):
        settings = {
            "MAX_CONCURRENT_SESSIONS": "15",
            "LIVE_SESSION_LEASE_MS": "120000",
            "LIVE_SESSION_RATE_LIMIT": "60",
            "LIVE_SESSION_RATE_WINDOW_MS": "300000",
        }
        self.check_api_only(resolve_compose(settings), settings)

    def test_explicit_empty_is_forwarded_for_api_rejection(self):
        for name in DEFAULTS:
            with self.subTest(variable=name):
                expected = {**DEFAULTS, name: ""}
                self.check_api_only(resolve_compose({name: ""}), expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
