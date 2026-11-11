# Project Proposal: K9DB Data Ownership Graph + RuleKeeper

## Overall Pipeline

The project consists of **5 parts**, divided into two stages: offline ownership inference and runtime policy enforcement.

```text
[Offline Stage]

1. Schema & Ownership Annotations
              ↓
2. Data Ownership Graph (DOG) Builder
              ↓
   Ownership Descriptors / Paths
              ↓
[Runtime Stage]

3. DOG Owner Resolver
              ↓
4. RuleKeeper Integration & Enforcement
              ↓
        Allow / Deny

5. Evaluation (Correctness, Performance, Developer Effort)
```

## Part 1 — Schema & Ownership Annotations

**Goal:** Define the input format for ownership inference.

**Tasks:**
- Extract collection schemas and reference relationships from MongoDB/Mongoose.
- Define ownership annotations inspired by K9DB (`OWNED_BY`, etc.).
- Identify data subject collections.
- Represent direct ownership relationships between collections.

**Output:** Schema metadata and annotated ownership relationships.

## Part 2 — Data Ownership Graph (DOG) Builder

**Goal:** Automatically infer ownership relationships from schema annotations.

**Tasks:**
- Construct a schema-level ownership graph.
- Generate direct ownership descriptors.
- Infer multi-hop transitive ownership paths.
- Detect cycles and handle multiple ownership paths where supported.
- Generate ownership metadata for runtime resolution.

**Output:** DOG and ownership descriptors for each collection.

## Part 3 — DOG Owner Resolver

**Goal:** Resolve actual data owners from MongoDB records using inferred ownership paths.

**Tasks:**
- Translate ownership descriptors into MongoDB queries.
- Resolve direct ownership through reference fields.
- Resolve transitive ownership through multi-hop queries.
- Return owner IDs for matching documents.
- Handle missing references and duplicate owners.

**Output:** Resolved data subject IDs.

## Part 4 — RuleKeeper Integration & Enforcement

**Goal:** Integrate DOG ownership information into RuleKeeper's existing policy enforcement pipeline.

**Tasks:**
- Extend RuleKeeper to recognize DOG-derived ownership metadata.
- Connect the DOG Resolver to Mongoose middleware.
- Convert resolved owner IDs into RuleKeeper's `subjects` format.
- Reuse existing Rego/WASM policy evaluation.
- Support ownership enforcement for CRUD operations.

**Output:** An integrated system that makes Allow/Deny decisions using automatically inferred ownership relationships.

## Part 5 — Evaluation

**Goal:** Evaluate the correctness, overhead, and practical benefits of DOG-enhanced RuleKeeper.

**Tasks:**
- **Correctness:** Test direct and transitive ownership inference and authorization decisions.
- **Performance:** Measure inference time, owner-resolution latency, and end-to-end request overhead.
- **Developer Effort:** Compare manual ownership declarations with DOG-based annotations.
- **Baseline Comparison:** Compare original RuleKeeper with DOG-enhanced RuleKeeper using equivalent ownership policies where possible.

**Output:** Evaluation results and an end-to-end demonstration.

## Implementation Scope

**Core MVP:**
- Schema annotations
- Direct ownership inference
- Multi-hop transitive ownership inference
- MongoDB owner resolution
- RuleKeeper policy enforcement
- Correctness and performance evaluation

**Optional Extensions:**
- Multiple ownership paths and shared ownership
- Variable/reverse ownership
- Ownership indexing and caching
- Incremental ownership updates

## Final Deliverables

1. **DOG Engine:** Schema-level ownership inference and runtime owner resolution.
2. **DOG-enhanced RuleKeeper:** Integrated ownership-aware policy enforcement for MongoDB.
3. **Evaluation:** Correctness, performance, and developer-effort comparisons.
