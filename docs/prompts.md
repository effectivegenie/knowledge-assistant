# Prompt Templates for AI-Assisted Development

A collection of high-signal prompts that consistently produce production-quality output. Use them as starting points and adapt to the specific context.

---

## 1. Architecture Planner

Use when starting a new feature or system. Forces the model to reason before touching code.

```
Plan the implementation like a senior software architect. Do not write code yet.

Explain:
- Architecture and design decisions
- Data flow end-to-end
- Services and components involved
- Database schema changes
- Potential scaling issues
- Security considerations

Then produce an ordered implementation plan with clear steps.
```

---

## 2. Production-Grade Implementation

Use when you want enterprise-quality code, not a prototype.

```
Implement this feature as production-grade code.

Requirements:
- Clean architecture with clear separation of concerns
- Comprehensive error handling with meaningful messages
- Structured logging at appropriate levels
- Configuration-driven behaviour (no magic constants)
- Scalable design that handles growth
- Unit tests covering the core logic

Explain each significant design decision.
```

---

## 3. Step-by-Step Implementation

Use when a feature is large or complex. Keeps the agent controlled and reviewable.

```
Break this feature into self-contained implementation steps.

For each step:
- Explain the purpose of the change
- List all affected files
- Implement only that step

Stop and wait for confirmation before moving to the next step.
```

---

## 4. Senior Code Review

Use when you want a real review, not just style comments.

```
Review this code like a senior engineer preparing it for production.

Look for:
- Logic bugs and edge cases
- Performance bottlenecks
- Security vulnerabilities
- Architectural weaknesses
- Readability and maintainability problems

For each issue found, explain why it matters and suggest a concrete improvement.
```

---

## 5. Root Cause Debugging

Use when something is broken and you need to understand why, not just patch it.

```
Analyze this error like a debugging expert.

Explain:
- The root cause and why it occurs
- The execution path that leads to the failure
- Why the current code does not handle this case

Then propose the minimal fix that addresses the root cause without introducing side effects.
```

---

## 6. Performance Analysis

Use for backend code where latency or throughput matters.

```
Analyze this code for performance bottlenecks.

Focus on:
- Algorithmic complexity and unnecessary work
- Database query patterns (N+1, missing indexes, over-fetching)
- Memory allocation and retention
- Concurrency and parallelism opportunities

For each issue, estimate its impact and suggest a concrete improvement.
```

---

## 7. Codebase Orientation

Use when joining a new project or onboarding into an unfamiliar repository.

```
Analyze this repository and produce a technical overview covering:

- Overall architecture and design philosophy
- Key modules and their responsibilities
- Primary data flows from entry point to storage
- Dependencies between components
- Areas of technical debt or known risk

Write it for a senior engineer who needs to be productive quickly.
```

---

## 8. Comprehensive Test Generation

Use to produce tests that actually catch bugs, not just achieve coverage.

```
Generate comprehensive unit tests for this code.

Cover:
- The happy path with realistic inputs
- All significant edge cases
- Error conditions and failure modes
- Boundary values

Follow the project's existing test conventions. Prefer testing behaviour over implementation details.
```

---

## 9. Security Audit

Use before exposing any endpoint or handling user input.

```
Perform a thorough security review of this code.

Check for:
- Injection vulnerabilities (SQL, command, header, log)
- Authentication and session management weaknesses
- Authorization gaps and privilege escalation paths
- Sensitive data exposure (secrets, PII in logs or responses)
- Unsafe handling of untrusted input

For each finding, rate the severity and provide a concrete remediation.
```

---

## 10. Targeted Refactor

Use when code has grown messy and needs to be cleaned up without changing behaviour.

```
Refactor this code to production quality.

Goals:
- Simplify complex logic without changing observable behaviour
- Eliminate duplication by extracting well-named abstractions
- Improve naming so the code reads like a clear explanation
- Reduce coupling between components
- Apply relevant best practices for this language and framework

Explain each structural change and why it improves the code.
```
