# Retrying a provider job

Survey and PlanReview use the same job entry. A repeated error is a warning;
you can keep the timeout when changing the execution environment or retrying
an uncertain failure.

1. Run `jigwright job retry-preview <job-id> --json`.
2. Save the returned `inputTemplate` as `retry.json`. Fill in
   `retryExplanation.failureReason` and `retryExplanation.plannedAction`.
   Each accepts up to 4,000 characters. An unconfirmed cause is valid.
3. Run `jigwright job retry-request <job-id> --input retry.json --json`.

For example, the explanation can be:

```json
{
  "failureReason": "The process appears to have run inside the sandbox; the cause is not yet confirmed.",
  "plannedAction": "Retry from the authorized host environment with the same timeout."
}
```

This object belongs in the template's `retryExplanation` field. Keep the
template's job, failed-invocation and revision bindings. Explaining a host
retry does not itself grant host access; the usual execution authorization
still applies.

Preview reports `ready`, `grant-required`, or `blocked` with a reason. It
does not start work or reserve budget. Submission checks the current state
again. Resubmitting an unchanged file reconciles its existing replacement;
use a new preview to retry a later failed attempt.

The fixed defaults remain four total attempts, at most 60 minutes each,
four hours of cumulative reserved time, and the existing provider, fee and
token limits. Time is charged by reservation, not by how quickly a process
failed. Automatic retries record the observed error and their default action
without calling another model to explain it.

When a Grant is needed, submission returns the exact request and its path.
One Grant lists every extra capacity needed for the next attempt, including
provider count, reserved time, cost or tokens when those limits are exhausted.
It can keep the existing timeout, is bound to this job and failed attempt,
and is consumed once. After the existing Grant flow issues it, run
`jigwright job retry <job-id> --grant <grant-id> --json`.

The exception never rewrites default policy. If only total attempt count is
exhausted, only that budget appears in the request. The existing
`retry-request --timeout` Grant form and native `propose --resume` envelopes
remain compatible; new agent retries should use the explained input form.
