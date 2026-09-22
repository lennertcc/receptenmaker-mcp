# The Receptenmaker mobile app's API

Findings from decompiling the Android app (`nl.mobielbekeken.receptenmaker`, version 11.4.3,
`getKookboeken`-era build 28) with jadx, and probing the endpoint against a real account.

This is **not** what the MCP server currently uses. The server drives the website, as
described in [`design.md`](design.md). This document exists because the app reaches features
the website does not expose, and because its API is considerably easier to work with.

## The short answer about the "app-only" features

Of the three features the website lacks, only one is a server capability:

| Feature | Verdict |
| --- | --- |
| Cookbook create / rename / delete | **A real API.** Verified working end to end. |
| Shopping list | **Not server-side at all.** Ingredients are collected in the app and handed to an Android share sheet (`verzamelde_ingrediënten_versturen_via`, `Intent.createChooser`). Nothing is stored or retrievable. |
| Meal calendar | **Not server-side at all.** "Recept in agenda zetten" fires `Intent(ACTION_EDIT)` on `CalendarContract.Events` — the device's own calendar app. No Receptenmaker state exists. |

So there is no shopping list or meal plan to read or write. An MCP client can compose a
shopping list from `get_recipe` output itself, and put something in a calendar through
whatever calendar tooling it already has.

## Protocol

One endpoint, dispatching on a `function` name:

```
POST https://www.receptenmaker.com/app/functions.php
Content-Type: multipart/form-data; boundary=---------------------------14737809831466499882746641449
```

A single form part named `json`, of type `text/plain; charset=UTF-8`, whose body is a JSON
object carrying every parameter:

```json
{"function": "getKookboekenUser", "user": "370985", "password": "<MD5>",
 "sortKey": "title", "os": "android", "language": "nl", "version": "28"}
```

`os`, `language` and `version` are added to every request; `deviceID` is included when the
app has one. Before sending, the app rewrites three characters in the serialized JSON —
`+` → `plussign`, `m²` → `m2value`, `€` → `eurosign` — so the server presumably reverses
this. Anything posting `+` in a value must do the same.

A `dev` server setting switches the base URL to `https://www.recepten-app.nl/`.

### Authentication

There is no session and no token. Every request carries `user` and `password`, where
`password` is the **uppercase hex MD5** of the plaintext password (`lb6.s()`, applied in
`LoginActivity.w()`).

`login` takes `username` (e-mail or username, both work) plus the same MD5 and returns the
numeric account id to use as `user` thereafter:

```json
{"status": "ok", "user": "370985", "username": "...", "password": "<MD5>", "email": "..."}
```

Note that this account id is not the WordPress user id the website uses.

Sending an unsalted MD5 of the password on every request is weak by modern standards, and
the hash is password-equivalent for this API: anything holding it has full account access.
It is, however, strictly less sensitive to store than the plaintext.

### Response shape

Always `200 OK` with a JSON body containing `status` — `"ok"`, `"failed"`,
`"invalidCredentials"`. Collections arrive as **JSON-encoded strings nested inside the
JSON**, so `kookboeken` must be parsed a second time.

## Function catalogue

60 function names appear in the binary. Marked ✅ where verified against a live account.

### Cookbooks

| Function | Parameters | |
| --- | --- | --- |
| `getKookboekenUser` | `sortKey` | ✅ the account's own cookbooks |
| `getKookboeken` | — | ✅ public/featured cookbooks |
| `getKookboekenOtherUser` | `sortKey` | cookbooks shared by others |
| `getKookboek` | `kookboekID` | ✅ returns `selectedRecepten`, a list of recipe ids |
| `getKookboekInfo` | `kookboekID`, `textFilter` | returned `failed` with these; parameters not pinned down |
| `createNewKookboek` | — | ✅ returns the new `kookboekID`; creates it untitled |
| `setKookboekTitle` | `kookboekID`, `title` | ✅ also the only way to rename |
| `deleteKookboek` | `kookboekID` | ✅ |
| `setKookboekOpenbaarValue` | `kookboekID`, `openbaar` | ✅ returns `kookboekCode`, the share code |
| `setKookboekReceptAsHead` | `kookboekID`, `objectID` | sets the cover image |
| `putReceptIntoKookboek` | `kookboekID`, `objectID` | ✅ returns `kookboekenForDisplay` |
| `saveObjectFromKookboek` | `objectID`, `ignoreDuplicate` | copies someone else's recipe into your own |
| `getCookbookPDF` | `id`, `addImages` | |

In a cookbook listing, `id` identifies your own cookbooks and `objectID` the public ones.
The naming is inverted from what you would expect: `title` holds the **owner's** name and
`subtitle` the cookbook's own name.

### Recipes

| Function | Parameters | |
| --- | --- | --- |
| `addObject` | recipe fields | create |
| `saveEdits` | `objectID`, `receptCode` | update |
| `deleteObjectRequest`, `performDeleteObjectRequest` | `objectID` | delete, in two steps |
| `retrieveObjects` | `objects` | bulk fetch; also `retrieveObjectsForFileCache` |
| `getRecipeFromPhoto` | `imgData` | **OCR** — a photo of a recipe becomes fields |
| `parseContentsFromSite` | `site`, `contents`, `ignoreDuplicate` | import from a page |
| `getRecipePDF` | `objectID`, `addImages` | |
| `setRecipesMatching` | `recipeId`, `selectedRecepten` | the "bijpassende recepten" links |
| `didSetChangeAantalPersonenTo` | | serving-size rescale |
| `setShareValue`, `viewedRecept`, `startedKookstand` | | sharing and telemetry |
| `savePhoto`, `savePhotoAfterSet`, `setPhotoAsHead`, `setPhotoForSave`, `deletePhoto` | | photos |

### Account and content

`login`, `logout`, `createNewUser`, `createAnonymousUser`, `createNewUserFromAnonymous`,
`updateUser`, `deleteUser`, `deleteAllDataFromUser`, `forgot`, `getSettings`, `setSetting`,
`setADHValues`, `getTagList` ✅, `getCategoryList` ✅, `getConfiguration`, `getInspiratie`,
`getKooktechnieken` ✅, `getSeizoenskalender` ✅, `checkForNotifications`, `setPushToken`,
`getSubscriptionPaymentLink`, `getLastPaymentStatus`, `startSubscriptionTrial`,
`removePaymentMandates`, `adTapped`, `openedOwnKookboek`, `receivedObject`.

## What this would mean for the MCP server

Switching from the website to this API would be a substantial improvement: JSON instead of
HTML parsing, no nonces, no session to renew, no per-write form fetch, and it unlocks
cookbook management, OCR import and PDF export. It would also remove the scraping fragility
that the current parsers guard against.

Against that: it is an undocumented private API for a specific app build (`version: 28`), so
it can change without notice and has no compatibility promise — whereas the website has at
least been stable enough to render for years. The two also disagree on recipe ids, so a
switch is a rewrite of the client rather than a swap, and any stored credential would change
form.

A reasonable middle path is to keep the website client and add the app API only for what the
website cannot do at all: creating, renaming and deleting cookbooks.

## Reproducing

```sh
# APK from a mirror, verified to be the right package before analysis
unzip -p receptenmaker.apk AndroidManifest.xml | strings | grep mobielbekeken
jadx -d src --no-res receptenmaker.apk
grep -rhoE '"function",\s*"[a-zA-Z0-9_]+"' src/ | sed -E 's/.*"([a-zA-Z0-9_]+)"/\1/' | sort -u
```

The request builder is `lb6.V()`; `lb6.W()` injects `user` and `password`; `lb6.z()` returns
the base URL; `lb6.s()` is the MD5 helper.
