# GitHub adapter

## Purpose

Prepare and publish an exact archive pull request through injected GitHub transport and authorization inputs.

## Requirements

### Requirement: Pull Request Publication Retains Prepared Identity

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The GitHub adapter SHALL retain the prepared repository, base, branch and head commit when constructing a pull request request. The prepared payload SHALL omit credentials. Publication retries SHALL recover an existing matching pull request rather than create a duplicate, and a divergent branch SHALL remain an error.

#### Scenario: Preparation contains no credential material

covers: #Requirement: Pull Request Publication Retains Prepared Identity
test: packages/github-adapter/test/archive-pull-request.test.ts#prepares a credential-free least-privilege GitHub request

- **WHEN** an archive publication is prepared
- **THEN** the request identifies the exact repository and branch without carrying credentials

#### Scenario: Repeated publication reuses the existing pull request

covers: #Requirement: Pull Request Publication Retains Prepared Identity
test: packages/github-adapter/test/archive-pull-request.test.ts#real GitHub adapter creates a branch and PR once, then recovers by lookup

- **WHEN** the injected transport observes a completed publication on a repeated request
- **THEN** the adapter returns the matching existing pull request without a second creation
