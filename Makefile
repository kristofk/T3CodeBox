# T3CodeBox. Every target runs a script in ci/, the same locally and in CI.
#   make build test              build both images for this machine and test them
#   make build T3_VERSION=0.0.42 a specific T3 Code release (default: latest stable)
#   DOCKER="sudo -E docker" make test

DOCKER   ?= docker
REGISTRY ?= ghcr.io/kristofk
export DOCKER REGISTRY T3_VERSION IMAGE_VERSION PROVIDERS REASON FORCE

.PHONY: help check build test publish release edge scan upstream

help: ## Show the targets
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-10s %s\n", $$1, $$2}'

check: ## Lint scripts, Dockerfiles and compose.yaml; unit-test the dashboard
	ci/check.sh

build: ## Build both images for this machine's architecture
	ci/build.sh

test: ## Start the built images with compose.yaml and run the checks
	ci/test.sh

publish: ## Push this architecture's tested images by digest
	ci/publish.sh

release: ## Combine the architectures, move the tags, publish release notes
	ci/release.sh

edge: ## Combine the architectures and move the edge tag (newest main, not released)
	ci/edge.sh

scan: ## Trivy scan of the published images
	ci/scan.sh

upstream: ## Is a release build due for the latest T3 Code?
	@ci/upstream.sh
