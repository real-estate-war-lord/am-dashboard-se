# v2.1 "Sweden fit" — julkaisumuistiinpanot

Haara `v2.1-sweden`, kuusi peräkkäistä vaihetta. **Yksikään luku ei muuttunut** — mikään laskenta ei muuttunut. Muuttui se, mitkä luvut ovat etusijalla, mitä sivu sanoo kun tieto on vielä matkalla, ja paljonko sivu painaa. Päätökset `docs/v2_1/DECISIONS.md`, vaiheiden omat muistiot `docs/v2_1/PROGRESS.md`.

## Mitä valmistui, vaiheittain
- **P1** Testikehys `tests/ui_v2_1/spec.py` (jokainen tarkistus lukee mitä sivu *sanoo* latausten jälkeen) + v2.0-auditoinnin neljä bugia: Test propertyn neljä osiota ei latautunut koskaan loppuun ("Grocery 0" kun lähellä oli 31), gatewayn uudelleenyrityssuma (~90 kutsua 14 s), rikostilaston uusin neljännes puuttui, Data › National -numeroformaatit.
- **P2 Map only** (`#map?ind=none`, näppäin `0`) — rajat ilman värjäystä, edelleen klikattavina. Ei uusi indikaattori eikä uusi kerros vaan indikaattorin puuttuminen, samassa `ind=`-avaimessa.
- **P3** Ruotsi-sovitus: kuusi tunnuslukua joista viisi julkaistaan kuntatason alle; kuntatason indikaattoria ei enää maalata jokaiselle osa-alueelle; hyresrätt/bostadsrätt-sanasto selityksineen (K/T-tal ≠ €/m²); haku ilman å ä ö; Charts aukeaa valmiilla kuvaajalla.
- **P4** Kartta on sivu (alkaa 200 px:n sisällä yläreunasta, kunnan kortti sen päällä, tila linkissä `card=0`) ja paino **17,1 MB → 4,8 MB**: rajat merkkijonoina, RegSO haetaan sivun viereltä ja puuttuva tieto sanoo "Loading…", ei koskaan 0 eikä viiva.
- **P5** Test property: seitsemän vastausta heti ylhäällä, kukin nappi omaan osioonsa; suora ja jonotarjonta erikseen (mediaanit vain suorista); vaarakerrokselle kolmas vastaus "Not mapped"; yksityisyyslauseke yhdellä rivillä.
- **P6** Regressio 11 reittiä × 4 näyttökokoa (0 page erroria, ei vaakavieritystä), pikkukarttojen neljä kulmaa mitattuna, kuvakaappaukset `docs/ui_v2_1/`, CHANGELOG ja README. Korjattu: Pipelinen statuspallo katkesi omalta sanaltaan, karttapalkki typisti indikaattorin nimen ("Rent, … S…"), kuntahuomautus piirtyi pikkukartan selitteen päälle.

## Mitä jätettiin tekemättä ja miksi
- **Vaara-alueet eivät ole Map only -tilassa**: kerros tarvitsee ilmastoindikaattorin, ja sellaisen valitseminen lukijan puolesta keksisi skenaarion. Muut Layers ▾ -kerrokset toimivat.
- **Charts-valitsimessa ei ole Map only -riviä** — kuvaajan akseli ei voi olla "ei mitään". **`lvl=regso`-avainta ei tehty**: taso on polussa (`#map/0180` = RegSO), ja toinen tapa sanoa sama olisi vain virhelähde.
- **Lupakarttaa ei ole eikä tule**: rakennusluvilla ei ole kuntatasoa (TAB2534/TAB796 = 30 aluekoodia). Boverket BME:n oma haku vaatii selainajon, ei tämän julkaisun aihe.

## Avoimet ⚠
- `indExplain`in "as of" putoaa RegSO/DeSO-tasolla kunnan aikaleimaan, vaikka tasolla on oma.
- Aluesivun pikkukartta rajautuu alueeseen itseensä → kuntatason indikaattorilla ruutu on enimmäkseen yhtä täyttöä. Data › Areas näyttää saman luvun yhä rivi per alue (`muni`-merkinnällä).
- `data/processed/regso/` + `deso/` = 14,8 MB committoitua JSONia (itse sivu pieneni selvästi). Puhelimessa kuntahuomautus piiloutuu kun selitelaatikko avataan — sama lause on siinä.
- Brå:n neljännesvuosiexportista puuttuu 2014K3/K4. Lähdetiedosto, ei jäsennin.

## Katselmus: http://localhost:8081/ — kahdeksan kohtaa
1. `#map` — kartta alkaa heti ylhäältä ja täyttää ikkunan, ei tyhjää sen alla.
2. `#map?ind=none` — pelkät rajat, ei selitettä eikä vuosivalitsinta; näppäin `0` palauttaa indikaattorin.
3. `#map/0180?ind=rent` — Tukholma täytettynä, RegSO ääriviivoina, luku **kerran** eikä 127 kertaa.
4. `#area/regso/0180R001_RegSO2025` — kuusi tunnuslukua, rent merkitty "municipality figure"; pikkukartan keltainen huomautus **ei** peitä selitettä.
5. `#property?p=59.31972,18.07194:Test` — seitsemän vastausta; latautuessa "…", ei koskaan 0.
6. `#data/projects` — statuspallo ja sana samalla rivillä, tyhjä budjetti sanoina ("programme only").
7. `#data/national` — desimaalit sarjakohtaisia, koron muutos pp:nä, ei "−0,0" missään.
8. Kavenna `#map/0180` 390 px:iin — kortti on alalaidan levy, kerrokset omilla kaistoillaan.
