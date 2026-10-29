# External requests (drafted at M0, to be filed by a person)

Nothing here has been sent. Each item names who acts and what "done" looks like.

## 1. Public path /kg on data.sorghumbase.org (gorgonzola Apache + CSHL firewall)
Who: owner of the gorgonzola Apache config and the CSHL firewall.
Change, inside the data.sorghumbase.org vhost in conf/extra/httpd-ssl.conf:

    ProxyPass        /kg http://squam.cshl.edu:12000/kg
    ProxyPassReverse /kg http://squam.cshl.edu:12000/kg
    ProxyTimeout 60

then `apachectl configtest && apachectl graceful`, and open TCP 12000 on squam to gorgonzola only.
Done when: `curl -sI https://data.sorghumbase.org/kg/v1/releases` returns 200 (after M1a).

## 2. Bioregistry (https://github.com/biopragmatics/bioregistry)
Gramene owns these prefixes, so updates come from Gramene:
- `gramene.gene`: widen the pattern from the legacy `^GR:\d+$` to `^[A-Za-z0-9][A-Za-z0-9._:-]*$`
  and set the resolver to `https://data.sorghumbase.org/kg/ui/node/gramene.gene:$1`.
- `gramene.qtl`: widen `^\w+$` to `^[A-Za-z0-9._-]+$` (ids such as `QPGYR5.1`).
- New prefixes: gramene.genome, gramene.genetree, gramene.germplasm, gramene.sample,
  gramene.population, gramene.expt, gramene.assay, gramene.contrast, gramene.tffamily,
  gramene.collection (patterns in config/prefixes.yaml).
Until merged, config/prefixes.yaml is authoritative for validation.

## 3. Information Resource Registry (https://github.com/biolink/information-resource-registry)
Provisional ids in config/infores.yaml with `registered: false` need entries. Highest value first:
infores:sorghumbase, infores:gramene-kg, infores:plant-reactome, infores:ensembl-compara,
infores:expression-atlas, infores:sorghum-qtl-atlas, infores:gramene-qtldb, infores:grassius,
infores:rap-db, infores:eva. Record each PR URL in `registry_pr`.

## 4. Persist the mongod cache cap
Who: squam host owner. Add `storage.wiredTiger.engineConfig.cacheSizeGB: 64` to /etc/mongod.conf
so the next planned restart keeps the 64 GB cap that is currently runtime-only (a restart would
revert to ~125 GB and push the host into swap). No restart is needed now.
