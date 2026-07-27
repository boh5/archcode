#!/usr/bin/env bash

set -Eeuo pipefail

watchdog_seconds="${ARCHCODE_TEST_WATCHDOG_SECONDS:-600}"
diagnostic_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/archcode-test-diagnostics-${GITHUB_RUN_ATTEMPT:-local}-$$"
timeout_marker="${diagnostic_root}/timed-out"
turbo_log="${PWD}/.turbo/logs/ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$.ndjson"

mkdir -p "${diagnostic_root}" "$(dirname "${turbo_log}")"

dump_process_state() {
  {
    echo "::group::Test watchdog diagnostics"
    echo "Captured at: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    echo "Watchdog threshold: ${watchdog_seconds}s"
    echo
    echo "Process tree (arguments omitted):"
    ps -eo pid,ppid,pgid,sid,stat,etimes,wchan:32,comm --forest || true

    for process_dir in /proc/[0-9]*; do
      [[ -r "${process_dir}/cmdline" ]] || continue

      command_line="$(tr '\0' ' ' < "${process_dir}/cmdline" 2>/dev/null || true)"
      case "${command_line}" in
        *bun*|*turbo*)
          ;;
        *)
          continue
          ;;
      esac

      echo
      echo "Process ${process_dir##*/}: ${command_line}"
      if [[ -r "${process_dir}/status" ]]; then
        sed -n \
          -e '/^Name:/p' \
          -e '/^State:/p' \
          -e '/^Pid:/p' \
          -e '/^PPid:/p' \
          -e '/^Threads:/p' \
          -e '/^voluntary_ctxt_switches:/p' \
          -e '/^nonvoluntary_ctxt_switches:/p' \
          "${process_dir}/status" || true
      fi

      echo "Threads:"
      for thread_dir in "${process_dir}"/task/[0-9]*; do
        [[ -d "${thread_dir}" ]] || continue
        thread_name="$(cat "${thread_dir}/comm" 2>/dev/null || true)"
        thread_wait="$(cat "${thread_dir}/wchan" 2>/dev/null || true)"
        printf '  tid=%s name=%s wchan=%s\n' \
          "${thread_dir##*/}" \
          "${thread_name}" \
          "${thread_wait}"
      done

      echo "File descriptors (first 80):"
      ls -l "${process_dir}/fd" 2>&1 | sed -n '1,80p' || true
    done

    if [[ -f "${turbo_log}" ]]; then
      echo
      echo "Turbo structured log (last 200 lines):"
      tail -n 200 "${turbo_log}" || true
    fi
    echo "::endgroup::"
  } >&2
}

terminate_test_group() {
  local signal="$1"

  if [[ "${has_process_group}" -eq 1 ]]; then
    kill "-${signal}" -- "-${test_pid}" 2>/dev/null || true
  else
    kill "-${signal}" "${test_pid}" 2>/dev/null || true
  fi
}

watchdog() {
  sleep "${watchdog_seconds}"
  if ! kill -0 "${test_pid}" 2>/dev/null; then
    return
  fi

  : > "${timeout_marker}"
  echo "::error title=Test watchdog timed out::Tests were still running after ${watchdog_seconds}s" >&2
  dump_process_state
  terminate_test_group TERM
  sleep 10
  terminate_test_group KILL
}

echo "Running tests with streamed Turbo logs and a ${watchdog_seconds}s watchdog."

has_process_group=0
if command -v setsid >/dev/null 2>&1; then
  setsid bunx turbo run test \
    --ui=stream \
    --log-order=stream \
    --output-logs=full \
    --log-file="${turbo_log}" &
  has_process_group=1
else
  bunx turbo run test \
    --ui=stream \
    --log-order=stream \
    --output-logs=full \
    --log-file="${turbo_log}" &
fi
test_pid=$!

watchdog &
watchdog_pid=$!

cleanup_watchdog() {
  kill "${watchdog_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || true
}

handle_signal() {
  local signal="$1"
  terminate_test_group TERM
  exit "${signal}"
}

trap cleanup_watchdog EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

set +e
wait "${test_pid}"
test_status=$?
set -e

if [[ -f "${timeout_marker}" ]]; then
  wait "${watchdog_pid}" 2>/dev/null || true
  echo "Tests exceeded the ${watchdog_seconds}s diagnostic timeout." >&2
  exit 124
fi

exit "${test_status}"
