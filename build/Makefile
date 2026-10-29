# gramene-kg build. Usage:
#   make -C build RELEASE_ROOT=/usr/local/gramene/subsites/sorghum/v11 build      # kg00 .. kg70
#   make -C build RELEASE_ROOT=... promote                                       # kg80 (manual)
#   make -C build RELEASE_ROOT=... kg30_validate EXPECTATIONS_MODE=record        # one stage
#   make -C build RELEASE_ROOT=... status
# Stamps live in ../.state/<release>/; kg00 mints BUILD_ID (NEW_BUILD=1 forces a new build).
# Each stage target re-runs that stage; its prerequisites run only if their stamp is missing.
SHELL := /bin/bash
ifndef RELEASE_ROOT
$(error set RELEASE_ROOT, e.g. RELEASE_ROOT=/usr/local/gramene/subsites/sorghum/v11)
endif
export RELEASE_ROOT NO_VARIANTS EXPECTATIONS_MODE NEW_BUILD
ST := stages
RELEASE := $(shell RELEASE_ROOT=$(RELEASE_ROOT) bash -c '. ./config.sh >/dev/null 2>&1 && echo $$RELEASE')
S := ../.state/$(RELEASE)

STAGES := kg00_preflight kg05_catalogue kg10_extract kg20_transform kg25_publications kg30_validate \
          kg40_cards_degree kg60_load_mongo kg70_solr kg80_promote
.PHONY: build promote status codegen clean-stamps $(STAGES)

# NEW_BUILD=1 starts a new build at kg00 (which mints BUILD_ID and clears later stamps);
# otherwise the chain resumes from the first missing stamp.
build:
	@if [ "$(NEW_BUILD)" = 1 ]; then bash $(ST)/kg00_preflight.sh; fi
	$(MAKE) --no-print-directory $(S)/kg70_solr.done NEW_BUILD=
promote: kg80_promote

# stage -> previous stage (the stamp that must exist)
prev_kg05_catalogue := kg00_preflight
prev_kg10_extract := kg05_catalogue
prev_kg20_transform := kg10_extract
prev_kg25_publications := kg20_transform
prev_kg30_validate := kg25_publications
prev_kg40_cards_degree := kg30_validate
prev_kg60_load_mongo := kg40_cards_degree
prev_kg70_solr := kg60_load_mongo
prev_kg80_promote := kg70_solr

kg00_preflight: ; bash $(ST)/kg00_preflight.sh
$(S)/kg00_preflight.done: ; bash $(ST)/kg00_preflight.sh

define STAGE_RULES
$(1): $(S)/$(prev_$(1)).done ; bash $(ST)/$(1).sh
$(S)/$(1).done: $(S)/$(prev_$(1)).done ; bash $(ST)/$(1).sh
endef
$(foreach s,$(filter-out kg00_preflight,$(STAGES)),$(eval $(call STAGE_RULES,$(s))))

status:
	@echo "release=$(RELEASE) build_id=$$(cat $(S)/build_id 2>/dev/null || echo none)"
	@for s in $(STAGES); do if [ -f $(S)/$$s.done ]; then echo "  [x] $$s ($$(cat $(S)/$$s.done))"; else echo "  [ ] $$s"; fi; done

clean-stamps: ; rm -f $(S)/*.done

# regenerate JSON Schema / TypeScript / JSON-LD context from the LinkML profile
codegen:
	cd .. && G=schema/generated && mkdir -p $$G/json-schema $$G/typescript $$G/jsonld && \
	.venv/bin/linkml-lint --config schema/.linkmllint.yaml schema/gramene_kg.yaml && \
	.venv/bin/gen-json-schema --closed schema/gramene_kg.yaml > $$G/json-schema/gramene_kg.schema.json && \
	.venv/bin/gen-typescript schema/gramene_kg.yaml > $$G/typescript/gramene_kg.ts 2>/dev/null && \
	.venv/bin/gen-jsonld-context schema/gramene_kg.yaml > $$G/jsonld/context.jsonld 2>/dev/null && \
	echo "codegen ok"
