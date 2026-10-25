# MMORPG progression research for Watchtower per-tool ranks

Fetched 2026-10-02. Items marked (unverified) came from a search snippet or a secondary source, not a primary page.

## Per game

**Old School RuneScape / RuneScape 3** (the model to copy)
- Level 1-99 per skill. XP to reach level L = floor(1/4 * sum for l=1..L-1 of floor(l + 300*2^(l/7))). Each level costs about 10.4% more than the last, so the cost doubles every 7 levels. https://oldschool.runescape.wiki/w/Experience , https://runescape.wiki/w/Experience
- Level 10 = 1,154 XP, level 25 = 7,842, level 50 = 101,333, level 92 = 6,517,253, level 99 = 13,034,431. Level 92 is exactly half of 99's XP. (Level 10, 25 and 50 computed from the formula above; 92 and 99 from the wiki.)
- Each skill stops earning at 200,000,000 XP. A "virtual level" is shown past 99, up to 126 at 188,884,740 XP. https://oldschool.runescape.wiki/w/Experience
- RS3 has "elite" skills that run to 120: level 99 = 13,034,431, level 110 = 38,737,661, level 120 = 104,273,167. https://runescape.wiki/w/Experience
- Total level is the plain sum of skill levels. OSRS has 24 skills, so the maximum is 24 x 99 = 2,376. (The fetched page said 2,496, which does not add up. Treat the exact total as unverified.) The Max Cape needs 99 in every skill and costs 99,000 coins. 57,387 players have it as of 2026-10-01, against 811,290 with a 99 Strength cape. https://oldschool.runescape.wiki/w/Skill_cape
- Combat level is a weighted blend: +0.25 per level of Hitpoints, +0.25 per level of Defence, +0.25 per two levels of Prayer, plus one offence term, whichever is highest of Attack and Strength (0.325 each), Magic (0.4875) or Ranged (0.4875). Cap 126 for melee and 109 for ranged or magic. https://oldschool.runescape.wiki/w/Combat_level

**World of Warcraft**
- Current cap is level 90 (Midnight). Rested XP gives up to a 150% bonus. https://www.icy-veins.com/wow/midnight-leveling-guide (search snippet). The curve is steep, with nearly 5M XP needed to reach 90 (headline only; the page itself returned 403). https://www.icy-veins.com/wow/news/players-need-nearly-5-million-xp-to-hit-level-90-in-midnight/
- Rested XP is the catch-up mechanic. The classic rule is one bubble (10% of the level) per 16 hours in an inn, one per 64 hours logged off elsewhere, capped at 15 bubbles (150% of the level), and it doubles kill XP until used up. Midnight numbers may differ. https://warcraft.wiki.gg/wiki/Rest
- Renown is per-faction, not per-character. In Dragonflight and later, 1 renown = 2,500 reputation. Caps are 20-30 per faction, then a 7,500 reputation "maximum renown" tier, then paragon-style rewards. https://warcraft.wiki.gg/wiki/Renown
- PvP rating tiers: Combatant 1000-1199, Challenger 1400-1599, Rival 1800-2099, Duelist 2100-2299, Elite 2300+, Gladiator = top 0.1% of the 3v3 ladder plus 150 wins. Each season ends with titles and mounts for the top. https://warcraft.wiki.gg/wiki/PvP_rating
- Mythic+ score colours are percentile bands: common 0-40th, uncommon 40th-75th, superior 75th-90th, legendary 90th-100th, with the shade shifting every 25 points. A static threshold also exists (above 2200 is always epic). https://support.raider.io/kb/raider-dot-io-mythic-plus-addon/what-are-the-different-colors-that-correspond-to-rating-for-raider-dot-io

**Final Fantasy XIV**
- Every job has its own level on one character, and the cap is 100 for all combat, crafting and gathering jobs. Exceptions: Blue Mage 80, Beastmaster 50. At the cap, no more EXP is earned. https://ffxiv.consolegameswiki.com/wiki/Armory_Bonus
- Armory Bonus: a job below your highest-level job gets +100% EXP for levels 1-89 and +50% for 90-100. It applies to kills and FATEs only. This is a catch-up mechanic that costs nothing to fake. https://ffxiv.consolegameswiki.com/wiki/Armory_Bonus
- There is no composite character level. Status is the set of job levels.

**Guild Wars 2**
- Level cap is 80, reached at 4,860,359 total XP. After that, XP keeps flowing into Mastery. https://wiki-en.guildwars2.com/wiki/Mastery_point
- Mastery rank is the count of mastery points spent. 267,824,158 total XP reaches rank 700, and 899 points exist across regions. Once a region is complete, spare XP turns into Spirit Shards at 254,000 XP each. https://wiki.guildwars2.com/wiki/Mastery
- Mastery gates new abilities, not raw stats. Wizard's Vault runs daily and weekly objectives for a rotating reward currency. https://metaforge.app/guild-wars-2/what-to-do-at-level-80-in-guild-wars-2-full-priority-guide (search snippet)

**Lost Ark and Black Desert**
- Lost Ark has a roster level, which is an account-level number gained from characters. The search result gave 250 as its maximum (unverified; the source pages blocked fetching). Item level is the real power measure and keeps growing with each patch. https://dotesports.com/mmo/news/what-are-roster-levels-in-lost-ark (search snippet)
- Black Desert has Family Fame, a composite of Combat Fame, Life Fame and Special Fame (knowledge and contribution points). It pays a daily silver reward that grows with fame. https://blackdesertonline.fandom.com/wiki/Fame (search snippet)

**Diablo 4 (prestige and seasons)**
- Paragon is levels 1-300, account-wide. Season Paragon XP carries over to the Eternal Realm from Season 7 onward. Level 284 is about the XP midpoint of 300. Reaching 300 takes about 200 hours of grinding and is rewarded with a mount. https://www.icy-veins.com/d4/news/paragon-experience-will-be-carried-over-from-seasons-to-the-eternal-realm-starting-with-diablo-4-season-7/ (search snippet)

## Patterns

| System | Level scope | Curve | Cap and beyond-cap | Rating tiers | Seasonal or lifetime |
|---|---|---|---|---|---|
| OSRS / RS3 | Per skill, plus a total-level sum | Exponential, x2 every 7 levels; 92 = half of 99 | 99, then virtual levels to 126; 200M XP hard cap; max cape; 120 in RS3 elite skills | None | Lifetime |
| WoW | Per character; renown per faction | Steep, with a vast jump near the cap | 90; renown paragon | PvP 6 named tiers; M+ colour bands | Both: levels are lifetime, ratings reset each season |
| FFXIV | Per job | Gentle, with a catch-up bonus | 100; no beyond-cap | None | Lifetime |
| GW2 | Character to 80, then account Mastery | Fast to 80, then a flat grind | Mastery rank to 700+ | None | Lifetime, plus a rotating weekly vault |
| Lost Ark / BDO | Account roster or fame composite | Composite | Roster 250 (unverified); item level is the endgame | Item-level bands | Lifetime |
| Diablo 4 | Character 60, account Paragon 300 | Gentle early, grindy late | Paragon is the beyond-cap layer | None | Seasonal, folded into lifetime |

## What makes them feel good

- **Fast early, slow late.** In OSRS, level 25 costs 7,842 XP, 0.06% of 99. Level 50 is 0.8%, level 70 is 5.7%, level 92 is 50%. The first 50 levels together cost under 1% of the total. Each level needs more XP than the last, yet it is always one step.
- **A visible next milestone.** The bar to the next level is always on screen, and OSRS adds "XP to 99". Mastery rank in GW2 sits beside the XP bar.
- **Catch-up.** WoW rested XP (150% cap) and FFXIV's Armory Bonus (+100% below your best job) both help a returning or new character. Both are tied to real play, never to idle time.
- **Beyond the cap.** Virtual levels, the max cape, paragon, mastery rank and a roster composite all give a reason to keep playing.

## Mapping to our use case

Sizing: a heavy user at 4-6 active hours a day makes 1,460-2,190 active hours a year. Each curve is sized so 5h/day (about 1,825 h/yr) reaches the cap in 1-2 years.

Shared rules for all options. XP is active hours only, taken from the existing `window_s`, so the gap cap already stops idle farming. Each tool has its own level. A combined "Total level" is the sum of the tool levels, as in OSRS. No hours means no rank and an explicit "no reading". Never show Level 1 as if a measurement existed.

### Option A: OSRS curve (exponential)
- **XP from hours:** 1 XP = 1 active minute (60 XP per hour). Optional per-tool normalisation, none needed.
- **Curve:** hours(L) = 2,500 x xp_osrs(L) / 13,034,431, with 99 at 2,500h. Level 10 = 0.2h, 25 = 1.5h, 50 = 19.4h, 70 = 141h, 80 = 381h, 90 = 1,025h, 92 = 1,250h, cap 99 = 2,500h. A heavy user gets 92 in about 8 months and 99 in about 16 months.
- **Tiers:** 1-9 Noobie, 10-24 Apprentice, 25-49 Builder, 50-69 Intermediate, 70-84 Advanced, 85-98 Pro, 99 Master. This matches the existing seven names.
- **Beyond cap:** virtual levels to 126 at 2,500h x 14.5 = about 36,000h, which is out of reach. Use a Max Cape (99 in all three tools). Also show the Total level (3 x 99 = 297).
- **Seasonal or weekly:** none. Keep it lifetime, with a separate weekly card for the 600-point Usage Profile.
- **Gaming risk:** minutes are earned only while active, so idling does nothing. The risk is cosmetic: levels 1-50 pass in a day, which gives onboarding joy but little ongoing signal.

### Option B: FFXIV curve (polynomial, gentle)
- **XP from hours:** same, 60 XP per hour. Each tool also shows an "Armory Bonus" marker for its lowest tool, a nudge only. **Do not** let it add hours: this would be a fabricated measurement.
- **Curve:** hours(L) = 2,000 x (L/100)^2.2, cap 100 at 2,000h. Level 10 = 12.6h, 25 = 94.7h, 50 = 435h, 75 = 1,062h, 100 = 2,000h. A heavy user hits 100 in about 13 months.
- **Titles:** per 10 levels, FFXIV-style job titles, e.g. Initiate, Journeyman, Adept, Expert, Veteran, Elite, Sage, Grandmaster.
- **Beyond cap:** prestige stars (Diablo-style): every 250h past the cap adds one star, uncapped, shown as "Lv100 +3". It is real hours, so no fabrication.
- **Seasonal or weekly:** a quarterly season badge from the best tool-week. It does not touch lifetime XP.
- **Gaming risk:** low. Stars past the cap reward volume only, so heavy sessions of low value would earn them. Mitigate by showing quality (the discipline score) beside it, never merging the two.

### Option C: Tiered ladder with sub-levels and a rating (WoW style)
- **XP from hours:** 60 XP per hour. Rank = lifetime level. A separate **rating** is the weekly Usage Profile score out of 600, shown with Raider.IO-style colour bands set by your own history percentile (bottom 40% common, 40-75 uncommon, 75-90 superior, top 10% legendary).
- **Curve:** levels 1-60, hours(L) = 2,400 x (L/60)^2.5. Level 10 = 27h, 25 = 269h, 50 = 1,521h, cap 60 = 2,400h. A heavy user hits cap in about 16 months. The mid-curve is slower than A or B, so level 50 lands around month 10.
- **Tiers:** 7 named tiers on the existing names, each split into sub-levels. Rating bands add colour: common, uncommon, superior, legendary. Titles come from the rating, such as "Gladiator" for a score in your top 0.1% of weeks.
- **Beyond cap:** paragon levels with a flat +100h each, uncapped, as in Diablo. A Master tier holder also earns a title by weekly rating, which resets each season.
- **Seasonal or weekly:** yes, native. The weekly rating resets each season; lifetime level never does.
- **Gaming risk:** rating can be gamed if it rewards raw counts, so keep it as the existing, already-guarded discipline score. Percentile bands against only your own history are not a leaderboard and must say so.

## Recommendation

Choose **Option A with Option B's prestige stars beyond the cap**: OSRS exponential curve (99 at 2,500h per tool) and the existing seven tier names, a Total level that sums the three tools, and a Max Cape for 99 in all of them. The curve is the best-proven in games, its formula is public and exact, and it needs only one stored number per tool, lifetime active hours, so it stays a pure function of `window_s` with no new model in TypeScript. The early levels fall fast (level 50 in 19h), the next milestone is always near, and the slope bends hard from level 70 so the last tier feels earned. Past 99, add one star per 250h so a user at the cap still sees progress, and keep the weekly 600-point Usage Profile as a separate, quality-based card rather than merging it into the level, which stops volume from standing in for skill. Do not copy rested XP: any bonus that credits hours not worked would fabricate a measurement, so use a display-only "welcome back" marker instead. The 2,500h cap matches a heavy user's 16-month timeline, and tools with less use simply stay lower, as in OSRS. Whether the Master hour mark should stay at 5,000h for Claude (as today) or move to 2,500h is the one decision for the owner, because it changes existing ranks.
