/* A synthetic Arena payload in the real one's shape.
 *
 * Invented addresses, ids and prices — no third-party listing data is
 * committed to this repository. What is faithful is the *structure*, which is
 * what the tests are about:
 *   - the {status, data} envelope with `data` as a JSON **string**
 *   - entity-escaped Swedish characters in DescriptionHtml
 *   - Description empty where DescriptionHtml is populated (the Heimstaden
 *     pattern: 15 of 489 records carry Description, 486 carry the HTML one)
 *   - YearBuilt === 0 meaning "unknown", not a year
 *   - FirstImage null on most records, and an object with no URL field on the
 *     rest — only Guid, Id, DateChanged and Extension are ever populated
 *   - coordinates missing, and present-but-zero
 */
"use strict";

export const RECORDS = [
  {
    Guid: "aaaaaaaa-0000-0000-0000-000000000001",
    Id: "1000001-1001",
    Adress1: "Exempelgatan 12 A",
    AreaName: "Testby - Centrum",
    Latitude: 59.3170, Longitude: 18.0340,
    Cost: 9500, TotalCost: 9500, Size: 62, NoOfRooms: 2,
    Floor: 3, YearBuilt: 1974,
    AvailableDate: "2026-12-01T00:00:00",
    ShowDateStart: "2026-09-20T00:00:00",
    DetailsUrl: "/ledigt/detalj/id/1000001-1001",
    FirstImage: {
      Guid: "bbbbbbbb-0000-0000-0000-000000000001", Id: "90001",
      Description: null, Filename: null, ExternalUrl: null,
      DisplayLimitedToState: false, MultimediaTypeId: null,
      ExternalPartnerUrl: null, DateChanged: "2026-09-20T10:00:00.000",
      Extension: ".jpg",
    },
    NoOfImages: null,
    Description: null,
    DescriptionHtml: "<p><strong>Modern tv&aring;a p&aring; Exempelgatan</strong></p>\r\n<p>V&auml;lkommen till en ljus l&auml;genhet i popul&auml;ra Testby &ndash; n&auml;ra till allt.</p>",
  },
  {
    /* Ground floor (0 is real) and YearBuilt 0 (unknown, not year zero). */
    Guid: "aaaaaaaa-0000-0000-0000-000000000002",
    Id: "1000002-1002",
    Adress1: "Provvägen 5",
    AreaName: "Testby - Norr",
    Latitude: 59.3180, Longitude: 18.0350,
    Cost: 7300, TotalCost: 7300, Size: 45, NoOfRooms: 1,
    Floor: 0, YearBuilt: 0,
    AvailableDate: "2027-01-15T00:00:00",
    ShowDateStart: "2026-09-21T00:00:00",
    DetailsUrl: "/ledigt/detalj/id/1000002-1002",
    FirstImage: null,
    NoOfImages: null,
    Description: "Etta med balkong.",
    DescriptionHtml: "<p>Etta med balkong.</p>",
  },
  {
    /* No coordinates at all -> dropped. */
    Guid: "aaaaaaaa-0000-0000-0000-000000000003",
    Id: "1000003-1003",
    Adress1: "Okändgatan 1",
    AreaName: "Testby - Okänd",
    Latitude: null, Longitude: null,
    Cost: 8000, TotalCost: 8000, Size: 50, NoOfRooms: 2,
    Floor: 1, YearBuilt: 1990,
    AvailableDate: "2026-12-01T00:00:00",
    ShowDateStart: "2026-09-22T00:00:00",
    DetailsUrl: "/ledigt/detalj/id/1000003-1003",
    FirstImage: null, NoOfImages: null,
    Description: null, DescriptionHtml: "<p>Text.</p>",
  },
  {
    /* 0,0 — "no coordinate" written as a number -> dropped. */
    Guid: "aaaaaaaa-0000-0000-0000-000000000004",
    Id: "1000004-1004",
    Adress1: "Nollgatan 0",
    AreaName: "Testby - Noll",
    Latitude: 0, Longitude: 0,
    Cost: 6000, TotalCost: 6000, Size: 30, NoOfRooms: 1,
    Floor: 2, YearBuilt: 2001,
    AvailableDate: "2026-12-01T00:00:00",
    ShowDateStart: "2026-09-22T00:00:00",
    DetailsUrl: "/ledigt/detalj/id/1000004-1004",
    FirstImage: null, NoOfImages: null,
    Description: null, DescriptionHtml: null,
  },
  {
    /* The dedupe target: same flat as HOMEQ_TWIN below. */
    Guid: "aaaaaaaa-0000-0000-0000-000000000005",
    Id: "1000005-1005",
    Adress1: "Dubblettgatan 37 B",
    AreaName: "Testby - Väster",
    Latitude: 59.3166, Longitude: 18.0336,
    Cost: 5098, TotalCost: 5098, Size: 24, NoOfRooms: 1,
    Floor: 4, YearBuilt: 1965,
    AvailableDate: "2026-11-02T00:00:00",
    ShowDateStart: "2026-09-19T00:00:00",
    DetailsUrl: "/ledigt/detalj/id/1000005-1005",
    FirstImage: null, NoOfImages: null,
    Description: null,
    DescriptionHtml: "<p>Etta n&auml;ra centrum.</p>",
  },
];

/* The envelope: `data` is a JSON string, not an array. */
export const PAYLOAD = { status: "success", data: JSON.stringify(RECORDS) };

export const PORTAL = { src: "testportal", label: "TestPortal", host: "https://portal.invalid" };

/* A HomeQ listing that is the same flat as record 1000005-1005 — note the
 * entrance letter written without a space, and the 0.4 m2 / 2 SEK drift. */
export const HOMEQ_TWIN = {
  src: "homeq", src_label: "HomeQ", id: 555001,
  url: "https://www.homeq.se/lagenhet/555001",
  address: "Dubblettgatan 37B", area_name: null,
  lat: 59.31661, lon: 18.03361,
  rent_sek_mo: 5100, size_m2: 24.4, rooms: 1,
  floor: null, year_built: null, available_from: "2026-11-02",
  published: null, image: null, text_start: null,
  discount: null, is_new_production: null, dist_m: 10,
};

/* A HomeQ listing at the same address that is a genuinely different flat. */
export const HOMEQ_NEIGHBOUR = {
  ...HOMEQ_TWIN, id: 555002,
  url: "https://www.homeq.se/lagenhet/555002",
  rent_sek_mo: 9200, size_m2: 58, rooms: 3, dist_m: 12,
};
