# External requests (drafted at M0, to be filed by a person)

Nothing here has been sent. Each item names who acts and what "done" looks like.

## 1. Public path /kg on data.sorghumbase.org (gorgonzola Apache + CSHL firewall)
Who: owner of the gorgonzola Apache config and the CSHL firewall.
Change, inside the data.sorghumbase.org vhost in conf/extra/httpd-ssl.conf:

    AllowEncodedSlashes NoDecode
    ProxyPass        /kg http://squam.cshl.edu:12000/kg nocanon
    ProxyPassReverse /kg http://squam.cshl.edu:12000/kg
    ProxyTimeout 60
    RedirectMatch ^/kg/?$ /kg/ui/          # optional: bare /kg opens the browse UI

then `apachectl configtest && apachectl graceful`, and open TCP 12000 on squam to gorgonzola only.
The target must keep the `/kg` path: the API serves everything under `/kg/v1`, `/kg/graphql` and `/kg/ui`.
`AllowEncodedSlashes NoDecode` plus `nocanon` let percent-encoded CURIEs through; DOIs contain `/`
(`/kg/v1/node/doi:10.1101%2Fgr.227462.117`), and without them Apache answers its own 404.

Status 2026-11-04 (evening): the `/kg` path is fixed. Every `/kg/v1` route, `/kg/graphql` and `/kg/ui/`
answer 200 through the proxy, and the 60-question REST eval passes 60/60 against
https://data.sorghumbase.org. One correction is still outstanding:
- **encoded slashes are refused by Apache** (its own HTML 404 for `/kg/v1/node/doi:10.1101%2Fgr.227462.117`).
  `AllowEncodedSlashes` is not inherited from the main server config: it has to be inside the
  data.sorghumbase.org `<VirtualHost *:443>` block, and the ProxyPass line needs `nocanon`. This affects the
  182 publication nodes whose id is a DOI. `/kg/v1/resolve?ids=doi:...` (query string) works meanwhile.
- optional: bare `/kg` still 404s (the RedirectMatch line was not added).

Done when all of these return 200 from outside squam:

    curl -sI https://data.sorghumbase.org/kg/v1/releases
    curl -sI 'https://data.sorghumbase.org/kg/v1/node/doi:10.1101%2Fgr.227462.117'
    curl -sI https://data.sorghumbase.org/kg/ui/

Then set `KG_PUBLIC_URL=https://data.sorghumbase.org/kg` on pm2 `gramene-kg-api` so JSON-LD `@context`
points at the public URL.

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
