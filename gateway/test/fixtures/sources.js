/* Synthetic payloads for the non-Arena snapshot sources, in the real ones'
 * shapes. Invented addresses, ids and prices — no third-party listing data is
 * committed to this repository.
 */
"use strict";

/* Willhem: Episerver Content Delivery. Note the shapes that have bitten:
 * properties wrapped as {value}, area with a Swedish decimal comma, and
 * noOfRooms as prose rather than a number. */
export const WILLHEM_LANDING = {
  notifications: [],
  data: { regionPages: [{ name: "Testby", contentLink: { id: 9001 } }] },
};

export const WILLHEM_CHILDREN = [
  {
    contentType: ["Page", "VacantObjectPage"],
    contentLink: { id: 700001 },
    name: "Exempelgatan 12 A",
    url: "/sok-bostad/Testby/exempelgatan-12-a/",
    address: "Exempelgatan 12 A",
    code: "900001",
    latitude: { value: 59.3170, propertyDataType: "PropertyFloatNumber" },
    longitude: { value: 18.0340, propertyDataType: "PropertyFloatNumber" },
    rent: "9500",
    area: "62,5",                     // Swedish decimal comma
    noOfRooms: "2 rum & kök",         // prose, not a number
    floor: "3",
    availableFrom: "2026-12-01T23:00:00Z",
    startPublish: "2026-09-20T00:00:00Z",
    description: "<h3>Om lägenheten </h3><p>Ljus tvåa med balkong.</p>",
    isNewProduction: null,
    isStudentApartment: null,
    isHomeQApartment: true,
  },
  {
    contentType: ["Page", "VacantObjectPage"],
    contentLink: { id: 700002 },
    name: "Provvägen 5",
    url: "/sok-bostad/Testby/provvagen-5/",
    address: "  Provvägen  5 ",       // stray whitespace
    code: "900002",
    latitude: { value: 59.3180 },
    longitude: { value: 18.0350 },
    rent: "7300",
    area: "45",
    noOfRooms: "1.5 rum & kök",
    floor: "0",
    availableFrom: null,
    startPublish: "2026-09-21T00:00:00Z",
    description: "<p>Etta med balkong. Kampanj: vi bjuder på första månaden.</p>",
    isStudentApartment: true,
  },
  {
    /* No coordinates -> dropped. */
    contentType: ["Page", "VacantObjectPage"],
    contentLink: { id: 700003 },
    name: "Okändgatan 1",
    url: "/sok-bostad/Testby/okandgatan-1/",
    address: "Okändgatan 1",
    code: "900003",
    latitude: { value: null },
    longitude: { value: null },
    rent: "8000", area: "50", noOfRooms: "2 rum & kök", floor: "1",
    description: "<p>Text.</p>",
  },
  /* A non-listing child, which must be ignored rather than normalised. */
  { contentType: ["Page", "RegionPage"], contentLink: { id: 9002 }, name: "Not a flat" },
];

/* Bostadsförmedlingen: /AllaAnnonser/ — a bare array, Swedish field names. */
export const QUEUE_RECORDS = [
  {
    "LägenhetId": 202500001, AnnonsId: 300001, Stadsdel: "Testby", Gatuadress: "Köexempelgatan 3",
    Kommun: "Teststad", Vaning: 2, AntalRum: 2, Yta: 56, Hyra: 8900,
    AnnonseradFran: "2026-09-22", AnnonseradTill: "2026-09-30",
    KoordinatLatitud: 59.3166, KoordinatLongitud: 18.0336, Url: "/bostad/202500001/",
    Vanlig: true, Ungdom: false, Student: false, Senior: false, Korttid: false,
    Nyproduktion: false, KoNamn: "Bostadskön",
    LiknadeLagenhetStatistik: { KotidFordelningQ1: 5, KotidFordelningQ3: 10 },
  },
  {
    "LägenhetId": 202500002, AnnonsId: 300002, Stadsdel: "Testby", Gatuadress: "Studentgatan 1",
    Kommun: "Testby", Vaning: 1, AntalRum: 1, Yta: 24, Hyra: 4200,
    AnnonseradFran: "2026-09-23", AnnonseradTill: "2026-09-29",
    KoordinatLatitud: 59.3175, KoordinatLongitud: 18.0345, Url: "/bostad/202500002/",
    Vanlig: false, Ungdom: true, Student: true, Senior: false, Korttid: false,
    Nyproduktion: false, KoNamn: "Bostadskön",
    LiknadeLagenhetStatistik: { KotidFordelningQ1: 2, KotidFordelningQ3: 4 },
  },
  {
    /* 0,0 -> dropped. */
    "LägenhetId": 202500003, AnnonsId: 300003, Stadsdel: "Noll", Gatuadress: "Nollgatan 0",
    Kommun: "Teststad", Vaning: 0, AntalRum: 1, Yta: 30, Hyra: 6000,
    AnnonseradFran: "2026-09-20", AnnonseradTill: "2026-09-28",
    KoordinatLatitud: 0, KoordinatLongitud: 0, Url: "/bostad/202500003/",
    Vanlig: true, KoNamn: "Bostadskön", LiknadeLagenhetStatistik: null,
  },
];

/* A fetch stub that answers each snapshot source with its own shape. */
export function upstreamFor(arenaPayload) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/mvcapi/search-landing")) return new Response(JSON.stringify(WILLHEM_LANDING), { status: 200 });
    if (u.includes("/api/episerver/")) return new Response(JSON.stringify(WILLHEM_CHILDREN), { status: 200 });
    if (u.includes("/AllaAnnonser")) return new Response(JSON.stringify(QUEUE_RECORDS), { status: 200 });
    return new Response(JSON.stringify(arenaPayload), { status: 200 });
  };
}
