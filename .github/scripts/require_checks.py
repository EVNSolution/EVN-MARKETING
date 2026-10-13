"""Fail closed when an automatically required job fails, is cancelled or is skipped."""
import json
import os
from pathlib import Path


def require_checks(plan, verify, application, controller_required, controller):
    if (plan != 'success' or verify != 'success' or application != 'success'
            or (controller_required, controller) not in {('true', 'success'), ('false', 'skipped')}):
        raise ValueError('every automatically required CI job must succeed')


def validate_reports(transitions, recovery, source):
    for suite, report in [('transitions', transitions), ('recovery', recovery)]:
        if report.get('sourceSha') != source or report.get('suite') != suite or report.get('ok') is not True:
            raise ValueError('controller evidence identity mismatch')
        traffic = report.get('traffic', {})
        if traffic.get('errors') != 0 or not traffic.get('reads', 0) > 0:
            raise ValueError('controller traffic evidence missing')
    if (transitions.get('publicErrors') != 0 or transitions.get('heldUploadDrains') != 2
            or transitions.get('controllerPublicProbes', 0) < 20):
        raise ValueError('transition evidence incomplete')
    if (transitions.get('mode') != 'real-clock'
            or transitions.get('releaseSequence') != ['a', 'b', 'c', 'b', 'a']):
        raise ValueError('consecutive releases must use real clocks without retention waits')
    validations = transitions.get('activationChecks', [])
    if (len(validations) != 4
            or any(check.get('revision') != letter * 40 or check.get('publicChecks', 0) < 5
                   or check.get('workerHeartbeatAdvanced') is not True
                   or not 8 <= check.get('seconds', 0) < 90
                   for check, letter in zip(validations, ('b', 'c', 'b', 'a')))):
        raise ValueError('every activation must prove web health and a renewed worker heartbeat')
    required_preflight = {'release:' + name for name in (
        'unreadable_renderer', 'missing_renderer', 'invalid_renderer', 'invalid_nginx')}
    required_preflight.add('rollback:unreadable_renderer')
    if set(transitions.get('preflightRejections', [])) != required_preflight:
        raise ValueError('preflight rejection must preserve the live web and worker in all five scenarios')
    expected = {'death_' + phase for phase in ('preparing', 'draining', 'switching', 'starting', 'observing')}
    expected |= {'host_flock', 'stopped_containers_and_proxy', 'killed_worker_natural_lease_expiry'}
    result = recovery.get('recovery', {})
    if (result.get('ok') is not True or result.get('recoveryScenarios') != 8
            or result.get('recoveryRecordsAdded') != 8 or result.get('finalPhase') != 'stable'
            or set(result.get('scenarios', [])) != expected):
        raise ValueError('all eight recovery scenarios and newest-data checks are required')


if __name__ == '__main__':
    if os.environ.get('CONTROLLER_REPORTS'):
        root = Path(os.environ['CONTROLLER_REPORTS'])
        validate_reports(*(json.loads((root / suite / 'controller-summary.json').read_text())
                           for suite in ('transitions', 'recovery')), os.environ['GITHUB_SHA'])
    else:
        require_checks(*(os.environ.get(name) for name in (
            'PLAN_RESULT', 'VERIFY_RESULT', 'APPLICATION_RESULT', 'CONTROLLER_REQUIRED', 'CONTROLLER_RESULT')))
