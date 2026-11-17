#!/usr/bin/env bash
set -euo pipefail

# Runs the two `run` blocks of the reusable workflow, as written, against
# throwaway git repos. The scan logic lives inline in the workflow because a
# called workflow cannot read other files of this repo, so the test reads the
# blocks out of the YAML instead of sourcing a script.
#
# Needs: git, curl, jq, yq. Run from anywhere: tests/secret-scan.test.sh

workflow="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/workflows/secret-scan.yml"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# -r gives raw strings from both tools named yq (the Go one and the jq wrapper).
step() { yq -r ".jobs.scan.steps[] | select(.name == \"$1\") | $2" "${workflow}"; }
# The shell GitHub runs a `shell: bash` step with.
as_runner() { bash --noprofile --norc -eo pipefail "$@"; }

export RUNNER_TEMP="${work}/runner-temp"
mkdir "${RUNNER_TEMP}"
step "Install Betterleaks" '.run' >"${work}/install.sh"
step "Scan the tracked files" '.run' >"${work}/scan.sh"
BETTERLEAKS_VERSION="$(step "Install Betterleaks" '.env.BETTERLEAKS_VERSION')"
BETTERLEAKS_SHA256="$(step "Install Betterleaks" '.env.BETTERLEAKS_SHA256')"
export BETTERLEAKS_VERSION BETTERLEAKS_SHA256

failed=0
check() { # description, expected, actual
  if [[ "$2" == "$3" ]]; then
    echo "ok    $1"
  else
    echo "FAIL  $1 (expected $2, got $3)"
    failed=$((failed + 1))
  fi
}

status=0
RUNNER_TEMP="$(mktemp -d -p "${work}")" BETTERLEAKS_SHA256="${BETTERLEAKS_SHA256//[0-9]/0}" \
  as_runner "${work}/install.sh" >"${work}/install-bad.log" 2>&1 || status=$?
check "install fails on a wrong checksum" 1 "${status}"

as_runner "${work}/install.sh" >"${work}/install.log" 2>&1 || { cat "${work}/install.log"; exit 1; }
check "install unpacks the pinned version" "${BETTERLEAKS_VERSION}" "$("${RUNNER_TEMP}/betterleaks/betterleaks" version)"

# Made at run time so that this repo never holds a string a scanner would flag.
# Two on one line: redacting one finding must not show the other.
random_token() { echo "ghp_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 36 || true)"; }
token="$(random_token)"
other_token="$(random_token)"
leak() { printf 'token = "%s"; other = "%s"%s\n' "${token}" "${other_token}" "${2:-}" >"$1"; }
except_app_js() {
  cat >"$1" <<'TOML'
[extend]
useDefault = true

[[allowlists]]
description = "test fixture"
paths = ['''^app\.js$''']
TOML
}

cases=0
scan() { # description, expected exit status, function that fills the repo
  cases=$((cases + 1))
  local repo="${work}/repo-${cases}" status=0
  git init --quiet "${repo}"
  (
    cd "${repo}"
    echo "hello" >README.md
    "$3"
    git add --all
    git -c user.name=test -c user.email=test@example.com commit --quiet --message fixture
    if declare -F "$3_after_commit" >/dev/null; then "$3_after_commit"; fi
  )
  (cd "${repo}" && as_runner "${work}/scan.sh" >"${work}/scan.log" 2>&1) || status=$?
  check "$1" "$2" "${status}"
  if grep --quiet --fixed-strings --regexp "${token}" --regexp "${other_token}" "${work}/scan.log"; then
    echo "FAIL  $1: the log shows the secret"
    failed=$((failed + 1))
  fi
}

clean() { :; }
secret() { leak app.js; }
secret_with_betterleaks_allow() { leak app.js ' # betterleaks:allow'; }
secret_with_gitleaks_allow() { leak app.js ' # gitleaks:allow'; }
gitleaksignore() { : >.gitleaksignore; }
betterleaksignore() { : >.betterleaksignore; }
secret_with_rule() { leak app.js; except_app_js .betterleaks.toml; }
secret_with_gitleaks_toml() { leak app.js; except_app_js .gitleaks.toml; }
secret_in_config() { except_app_js .betterleaks.toml; printf '# token = "%s"\n' "${token}" >>.betterleaks.toml; }
secret_in_subdirectory() { mkdir -p a/b; leak a/b/c.yaml; : >a/.gitleaksignore; }
secret_untracked() { :; }
secret_untracked_after_commit() { leak local.js; }
secret_deleted_from_worktree() { leak app.js; }
secret_deleted_from_worktree_after_commit() { rm app.js; }

scan "a clean repo passes" 0 clean
scan "a tracked secret fails" 1 secret
check "the log names the rule, file and line of both findings" 2 \
  "$(grep --count --fixed-strings '"github-pat" in "app.js", line 1' "${work}/scan.log" || true)"
scan "a betterleaks:allow comment does not except a secret" 1 secret_with_betterleaks_allow
scan "a gitleaks:allow comment does not except a secret" 1 secret_with_gitleaks_allow
scan "a root .gitleaksignore fails" 1 gitleaksignore
scan "a root .betterleaksignore fails" 1 betterleaksignore
scan "a rule in .betterleaks.toml excepts a secret" 0 secret_with_rule
scan "the same rule in .gitleaks.toml does not" 1 secret_with_gitleaks_toml
scan "a secret inside .betterleaks.toml fails" 1 secret_in_config
scan "a secret in a subdirectory fails, also beside an ignore file there" 1 secret_in_subdirectory
scan "an untracked file is not scanned" 0 secret_untracked
scan "a tracked file missing from the working tree is scanned" 1 secret_deleted_from_worktree

if ((failed > 0)); then
  echo "${failed} failed"
  exit 1
fi
