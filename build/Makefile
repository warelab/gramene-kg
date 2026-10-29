# gramene-kg build. Usage:
#   make -C build RELEASE_ROOT=/usr/local/gramene/subsites/sorghum/v11 build
#   make -C build RELEASE_ROOT=... kg05_catalogue        # one stage (and its prerequisites)
#   make -C build RELEASE_ROOT=... status
# Stamps live in ../.state/<release>/; kg00 mints BUILD_ID (NEW_BUILD=1 forces a new one).
SHELL := /bin/bash
.ONESHELL:
ifndef RELEASE_ROOT
$(error set RELEASE_ROOT, e.g. RELEASE_ROOT=/usr/local/gramene/subsites/sorghum/v11)
endif
export RELEASE_ROOT
ST := stages
RELEASE := $(shell RELEASE_ROOT=$(RELEASE_ROOT) bash -c '. ./config.sh >/dev/null 2>&1 && echo $$RELEASE')
S := ../.state/$(RELEASE)

STAGES := kg00_preflight kg05_catalogue
.PHONY: build status codegen clean-stamps $(STAGES)

build: kg05_catalogue

kg00_preflight: ; bash $(ST)/kg00_preflight.sh
kg05_catalogue: $(S)/kg00_preflight.done ; bash $(ST)/kg05_catalogue.sh
$(S)/kg00_preflight.done: ; bash $(ST)/kg00_preflight.sh

status:
	@echo "release=$(RELEASE) build_id=$$(cat $(S)/build_id 2>/dev/null || echo none)"
	@for s in $(STAGES); do if [ -f $(S)/$$s.done ]; then echo "  [x] $$s ($$(cat $(S)/$$s.done))"; else echo "  [ ] $$s"; fi; done

clean-stamps: ; rm -f $(S)/*.done

# regenerate JSON Schema / TypeScript / JSON-LD context from the LinkML profile
codegen:
	cd .. && G=schema/generated && mkdir -p $$G/json-schema $$G/typescript $$G/jsonld
	.venv/bin/linkml-lint --config schema/.linkmllint.yaml schema/gramene_kg.yaml
	.venv/bin/gen-json-schema --closed schema/gramene_kg.yaml > $$G/json-schema/gramene_kg.schema.json
	.venv/bin/gen-typescript schema/gramene_kg.yaml > $$G/typescript/gramene_kg.ts 2>/dev/null
	.venv/bin/gen-jsonld-context schema/gramene_kg.yaml > $$G/jsonld/context.jsonld 2>/dev/null
	@echo "codegen ok"
