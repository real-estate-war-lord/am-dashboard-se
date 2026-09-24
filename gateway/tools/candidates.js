/* Swedish landlords worth probing for a Vitec Arena tenant portal.
 *
 * Two groups: the large private residential owners, and the largest
 * allmännyttiga (municipal) company in each of the ~30 biggest kommuner.
 * Commercial-only owners (Vasakronan, Castellum, Wihlborgs) are left out —
 * they let offices, not flats — as are pure developers (JM, Bonava) and the
 * co-operative organisations (HSB, Riksbyggen), which sell rather than let.
 */
"use strict";

export const CANDIDATES = [
  /* --- large private --- */
  { name: "Willhem", domain: "willhem.se" },
  { name: "Wallenstam", domain: "wallenstam.se" },
  { name: "Stena Fastigheter", domain: "stenafastigheter.se" },
  { name: "Rikshem", domain: "rikshem.se" },
  { name: "Balder", domain: "balder.se" },
  { name: "Einar Mattsson", domain: "einarmattsson.se" },
  { name: "Magnolia Bostad", domain: "magnoliabostad.se" },
  { name: "SBB Norden", domain: "sbbnorden.se" },
  { name: "Akelius", domain: "akelius.se" },
  { name: "Ikano Bostad", domain: "ikanobostad.se" },
  { name: "Trianon", domain: "trianon.se" },
  { name: "Brinova", domain: "brinova.se" },
  { name: "K-Fastigheter", domain: "kfastigheter.se" },
  { name: "Amasten", domain: "amasten.se" },
  { name: "Graflunds", domain: "graflunds.se" },
  { name: "Lundbergs Fastigheter", domain: "lundbergsfastigheter.se" },
  { name: "Diös", domain: "dios.se" },
  { name: "Aranäs", domain: "aranas.se" },

  /* --- allmännyttan, largest per kommun --- */
  { name: "Stockholmshem", domain: "stockholmshem.se" },
  { name: "Svenska Bostäder", domain: "svenskabostader.se" },
  { name: "Familjebostäder Sthlm", domain: "familjebostader.com" },
  { name: "Poseidon (Göteborg)", domain: "poseidon.goteborg.se" },
  { name: "Bostadsbolaget (Göteborg)", domain: "bostadsbolaget.se" },
  { name: "Familjebostäder Gbg", domain: "familjebostader.se" },
  { name: "MKB (Malmö)", domain: "mkbfastighet.se" },
  { name: "Uppsalahem", domain: "uppsalahem.se" },
  { name: "Stångåstaden (Linköping)", domain: "stangastaden.se" },
  { name: "Hyresbostäder (Norrköping)", domain: "hyresbostader.se" },
  { name: "ÖrebroBostäder (ÖBO)", domain: "obo.se" },
  { name: "Mimer (Västerås)", domain: "mimer.nu" },
  { name: "Helsingborgshem", domain: "helsingborgshem.se" },
  { name: "LKF (Lund)", domain: "lkf.se" },
  { name: "Bostaden (Umeå)", domain: "bostaden.umea.se" },
  { name: "Gavlegårdarna (Gävle)", domain: "gavlegardarna.se" },
  { name: "Kfast (Eskilstuna)", domain: "kfast.se" },
  { name: "KBAB (Karlstad)", domain: "kbab.se" },
  { name: "Jönköpings Rådhus/Vätterhem", domain: "vatterhem.se" },
  { name: "Kopparstaden (Falun)", domain: "kopparstaden.se" },
  { name: "Tunabyggen (Borlänge)", domain: "tunabyggen.se" },
  { name: "AB Bostäder i Borås", domain: "bostader.boras.se" },
  { name: "Växjöbostäder", domain: "vaxjobostader.se" },
  { name: "HFAB (Halmstad)", domain: "hfab.se" },
  { name: "Mitthem (Sundsvall)", domain: "mitthem.se" },
  { name: "Östersundshem", domain: "ostersundshem.se" },
  { name: "Lulebo (Luleå)", domain: "lulebo.se" },
  { name: "Skebo (Skellefteå)", domain: "skebo.nu" },
  { name: "Eidar (Trollhättan)", domain: "eidar.se" },
  { name: "Uddevallahem", domain: "uddevallahem.se" },
  { name: "ABK (Kristianstad)", domain: "abk.se" },
  { name: "Kalmarhem", domain: "kalmarhem.se" },
  { name: "Karlskronahem", domain: "karlskronahem.se" },
  { name: "Övikshem", domain: "ovikshem.se" },
  { name: "Skövdebostäder", domain: "skovdebostader.se" },
  { name: "Varbergs Bostad", domain: "varbergsbostad.se" },
  { name: "Botkyrkabyggen", domain: "botkyrkabyggen.se" },
  { name: "Huge Bostäder (Huddinge)", domain: "huge.se" },
  { name: "Telge Bostäder (Södertälje)", domain: "telge.se" },
  { name: "Sollentunahem", domain: "sollentunahem.se" },
  { name: "Förvaltaren (Sundbyberg)", domain: "forvaltaren.se" },
  { name: "Järfällahus", domain: "jarfallahus.se" },
  { name: "Haninge Bostäder", domain: "haningebostader.se" },
  { name: "Tyresö Bostäder", domain: "tyresobostader.se" },
  { name: "Väsbyhem", domain: "vasbyhem.se" },
  { name: "Signalisten (Solna)", domain: "signalisten.se" },
  { name: "Nyköpingshem", domain: "nykopingshem.se" },
];

/* The subdomains the two known Arena tenants use, plus the obvious variants,
 * cheapest-first so a hit costs one request. */
export const HOST_PREFIXES = ["mitt", "minasidor", "minasidor2", "www"];
