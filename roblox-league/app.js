require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const app = express();

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || "mongodb+srv://vimsuperleague:alan78600@vimsuperleague.ic6a7ck.mongodb.net/vimhub?retryWrites=true&w=majority&appName=VIMSUPERLEAGUE";

mongoose.connect(mongoURI)
    .then(() => console.log("🔥 Connected to MongoDB Atlas! Data is now permanent."))
    .catch(err => console.log("❌ MongoDB Connection Error:", err));

// --- MIDDLEWARE ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: 'vim-super-league-2025-stable',
    resave: false,
    saveUninitialized: true
}));

const ADMIN_KEY = "yakuza26";

// --- MODELS ---
const Player = mongoose.model('Player', new mongoose.Schema({
    name: String,
    discord: String,
    password: { type: String, required: true },
    cardImage: { type: String, default: "" },
    verified: { type: Boolean, default: false },
    goals: { type: Number, default: 0 },
    assists: { type: Number, default: 0 },
    saves: { type: Number, default: 0 },
    mvps: { type: Number, default: 0 },
    position: { type: String, default: "FWD" },
    rank: { type: String, enum: ['C', 'B', 'A', 'S', 'SS'], default: 'C' },
    country: { type: String, default: "" },
    timezone: { type: String, default: "" },
    theme: { type: String, default: "blue" },
    experience: String,
    bio: String,
    views: [String],

    reservePrice: { type: Number, default: 0 },
    highestBid: { type: Number, default: 0 },
    highestBidder: { type: String, default: "" },

    // VSL Season 4 auction — set automatically when the admin starts the
    // auction (from `rank`) and finalized automatically when it ends.
    auctionStatus: { type: String, enum: ['available', 'sold'], default: 'available' },
    soldPrice: { type: Number, default: 0 },
    soldToTeam: { type: String, default: "" },

    // Private per-manager watchlist. Only meaningful on a Player document
    // that is also an assigned manager (see AuctionTeam.manager). Stores
    // the watched players' _ids as strings.
    watchlist: { type: [String], default: [] },

    0: { type: Number, default: 0 }
}));

const Match = mongoose.model('Match', new mongoose.Schema({
    teamA: String,
    teamB: String,
    logoA: String,
    logoB: String,
    time: String,
    scheduledAt: { type: Date },
    timezone: { type: String, default: "" },
    tags: String,
    isLive: Boolean,
    status: { type: String, default: 'upcoming' },
    details: Object
}));

const Group = mongoose.model('Group', new mongoose.Schema({
    name: String,
    teams: [{
        name: String,
        logo: String,
        mp: Number,
        wins: Number,
        loses: Number,
        pts: Number,
        roster: Array
    }]
}));

const AuctionTeam = mongoose.model('AuctionTeam', new mongoose.Schema({
    name: String,
    logo: { type: String, default: "" },
    budget: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    manager: { type: String, default: "" },

    bids: [{
        playerId: mongoose.Schema.Types.ObjectId,
        playerName: String,
        amount: Number,
        updatedAt: { type: Date, default: Date.now }
    }],
    roster: [{
        name: String,
        position: String,
        rank: String,
        boughtFor: Number
    }]
}));

// Immutable auction event log — every bid, withdrawal, win, and admin
// session action. Powers the audit log under the Auction tab, the
// "can this manager still withdraw?" rule, and outbid notifications.
const AuctionActivity = mongoose.model('AuctionActivity', new mongoose.Schema({
    type: {
        type: String,
        enum: ['bid', 'withdraw', 'won', 'auction_start', 'auction_end', 'rank_change'],
        required: true
    },
    playerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    playerName: { type: String, default: "" },
    teamId: { type: mongoose.Schema.Types.ObjectId, default: null },
    teamName: { type: String, default: "" },
    managerName: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    meta: { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now }
}));

const Info = mongoose.model('Info', new mongoose.Schema({
    liveLink: { type: String, default: "" },

    leaderboards: {
        scorers: { type: Array, default: [] },
        saves: { type: Array, default: [] },
        assists: { type: Array, default: [] }
    },

    records: { type: Array, default: [] },
    stories: { type: Array, default: [] },

    auction: {
        name: { type: String, default: "VSL Auction" },
        maxRosterSize: { type: Number, default: 16 },
        minRosterSize: { type: Number, default: 10 },
        status: { type: String, default: "ready" }, // ready | live | ended
        sessionStartedAt: { type: Date, default: null },
        sessionEndedAt: { type: Date, default: null }
    }
}));

// --- HELPERS ---

async function getInfo() {
    let info = await Info.findOne();

    if (!info) {
        info = await Info.create({});
    }

    return info;
}

function requireAdmin(req, res) {
    if (!req.session.isAdmin) {
        res.redirect('/admin-login');
        return false;
    }

    return true;
}

function parseDateTime(value) {
    if (!value) return null;

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date;
}

// ============================================================
// VSL SEASON 4 — AUCTION / CLASS RULES ENGINE
//
// Every rule from the VSL rating/class + roster-legality spec lives here,
// in one place, so /auction/bid, /auction/withdraw, the market badges,
// the manager dashboard, and the AI assistant all agree with each other.
// ============================================================

const STARTING_BUDGET = 100000;

const CLASS_RESERVE_PRICES = {
    SS: 10000,
    S: 8000,
    A: 6000,
    B: 4000,
    C: 2500
};

const ROSTER_MAX_DEFAULT = 16;
const ROSTER_MIN_DEFAULT = 10;
const CHEAPEST_RESERVE = CLASS_RESERVE_PRICES.C;

// Prefer the admin-configured auction session sizes; fall back to defaults.
function getRosterLimits(auctionSettings) {
    const a = auctionSettings || {};
    const maxR = Math.max(1, Number(a.maxRosterSize) || ROSTER_MAX_DEFAULT);
    const minR = Math.max(1, Math.min(maxR, Number(a.minRosterSize) || ROSTER_MIN_DEFAULT));
    return { rosterMin: minR, rosterMax: maxR };
}

function getAuctionStatus(info) {
    return (info && info.auction && info.auction.status) || 'ready';
}

// Bidding only while LIVE. PAUSED freezes bids/registration/ranks.
function isBiddingOpen(status) {
    return status === 'live';
}

// Rank edits blocked while LIVE or PAUSED.
function isRankFrozen(status) {
    return status === 'live' || status === 'paused';
}

// Registration blocked while LIVE or PAUSED.
function isRegistrationClosed(status) {
    return status === 'live' || status === 'paused';
}


// Fixed minimum bid increments — no meaningless +1/+2 bidding.
// Configurable in one place if the league wants different tiers later.
const BID_INCREMENT_TIERS = [
    { upTo: 5000, step: 100 },
    { upTo: 20000, step: 250 },
    { upTo: Infinity, step: 500 }
];

function getMinIncrement(currentAmount) {
    const amt = Number(currentAmount) || 0;
    for (const tier of BID_INCREMENT_TIERS) {
        if (amt < tier.upTo) return tier.step;
    }
    return BID_INCREMENT_TIERS[BID_INCREMENT_TIERS.length - 1].step;
}

// Rounds a proposed minimum bid up to the nearest valid increment step so
// the UI can always suggest a clean number (10100, not 10099).
function roundUpToIncrement(amount, step) {
    return Math.ceil(amount / step) * step;
}

function getPlayerClass(player) {
    const r = (player && player.rank ? player.rank : 'C').toString().toUpperCase();
    return ['SS', 'S', 'A', 'B', 'C'].includes(r) ? r : 'C';
}

function getReservePriceForClass(cls) {
    return CLASS_RESERVE_PRICES[cls] || CLASS_RESERVE_PRICES.C;
}

// Dynamic class caps driven by how many SS the team currently holds
// (including the manager if they are SS). No admin-granted exception —
// signing a 2nd SS automatically tightens S/A.
//
//   0 SS → SS max 2, S max 4, A max 6
//   1 SS → SS max 2, S max 3, A max 5
//   2 SS → SS max 2, S max 2, A max 3
function getClassCapsFromCounts(counts) {
    const ss = (counts && counts.SS) || 0;
    if (ss >= 2) return { SS: 2, S: 2, A: 3 };
    if (ss === 1) return { SS: 2, S: 3, A: 5 };
    return { SS: 2, S: 4, A: 6 };
}

function getEffectiveSCap(_team, counts) {
    return getClassCapsFromCounts(counts).S;
}

function getEffectiveACap(_team, counts) {
    return getClassCapsFromCounts(counts).A;
}

// A "manager account" is any verified Player whose name matches an
// AuctionTeam's assigned manager. Manager accounts are never auctionable.
function isManagerAccount(player, allTeams) {
    if (!player) return false;
    const name = (player.name || '').toLowerCase();
    return (allTeams || []).some(t => (t.manager || '').toLowerCase() === name);
}

function findTeamForManagerName(allTeams, name) {
    const lower = (name || '').toLowerCase();
    return (allTeams || []).find(t => (t.manager || '').toLowerCase() === lower) || null;
}

// A player counts toward a team's PROVISIONAL roster the moment that team
// holds the current highest bid on them (players aren't "won" for real
// until the admin ends the auction, but for roster-legality purposes a
// bid you're currently winning has to be treated as a committed slot).
//
// The assigned manager ALWAYS occupies one of the 16 roster slots and
// counts toward their own class cap (SS manager → 1 SS already used, etc.).
function getProvisionalRoster(team, playersById) {
    const roster = [];

    // Manager slot first — free (not paid via auction), but occupies class + total.
    if (team && team.manager) {
        const mgrLower = String(team.manager).toLowerCase();
        let managerPlayer = null;
        for (const p of playersById.values()) {
            if ((p.name || '').toLowerCase() === mgrLower) {
                managerPlayer = p;
                break;
            }
        }
        if (managerPlayer) {
            roster.push({ player: managerPlayer, amount: 0, isManager: true });
        }
    }

    for (const bid of (team.bids || [])) {
        const player = playersById.get(String(bid.playerId));
        if (!player) continue;
        // Don't double-count the manager if someone somehow bid on them.
        if (roster.some(r => r.isManager && String(r.player._id) === String(player._id))) continue;
        const isWinning =
            (player.highestBidder || '').toLowerCase() === (team.name || '').toLowerCase() &&
            Number(player.highestBid || 0) === Number(bid.amount || 0);
        if (isWinning) {
            roster.push({ player, amount: Number(bid.amount) || 0, isManager: false });
        }
    }
    return roster;
}

// Everything a manager needs to know about their own auction position —
// used by the market badges, the manager dashboard, and the AI assistant.
// rosterLimits: { rosterMin, rosterMax } from getRosterLimits(info.auction).
function computeManagerAuctionState(team, playersById, rosterLimits) {
    const limits = rosterLimits || { rosterMin: ROSTER_MIN_DEFAULT, rosterMax: ROSTER_MAX_DEFAULT };
    const rosterMin = limits.rosterMin;
    const rosterMax = limits.rosterMax;

    const provisional = getProvisionalRoster(team, playersById);

    const counts = { SS: 0, S: 0, A: 0, B: 0, C: 0 };
    for (const { player } of provisional) {
        counts[getPlayerClass(player)]++;
    }

    // ALL active bids lock money — including losing ones. Outbid managers
    // stay locked until the higher bidder withdraws (or admin force-drops).
    // Roster slots still only count WINNING bids (provisional above).
    const committed = (team.bids || []).reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
    const spent = Number(team.spent || 0);
    const budget = Number(team.budget || 0);
    const availableBudget = budget - spent - committed;

    const totalPlayers = provisional.length;
    const caps = getClassCapsFromCounts(counts);
    const sCap = caps.S;
    const aCap = caps.A;

    return {
        team,
        provisional,
        counts,
        totalPlayers,
        budget,
        spent,
        committed,
        availableBudget,
        caps: { SS: caps.SS, S: sCap, A: aCap },
        remainingSlots: {
            SS: Math.max(0, caps.SS - counts.SS),
            S: Math.max(0, sCap - counts.S),
            A: Math.max(0, aCap - counts.A),
            total: Math.max(0, rosterMax - totalPlayers)
        },
        rosterMin,
        rosterMax,
        outbidPlayerIds: (team.bids || [])
            .filter(b => {
                const player = playersById.get(String(b.playerId));
                if (!player) return false;
                return !(
                    (player.highestBidder || '').toLowerCase() === (team.name || '').toLowerCase() &&
                    Number(player.highestBid || 0) === Number(b.amount || 0)
                );
            })
            .map(b => String(b.playerId))
    };
}

// The heart of the "don't let a manager spend themselves into an
// impossible roster" requirement. Given a manager's state AFTER a
// hypothetical bid, checks whether at least one legal way remains to
// reach a full roster under the class caps + configured min/max sizes.
function canStillLegallyCompleteRoster(stateAfterBid) {
    const { counts, caps, totalPlayers, availableBudget } = stateAfterBid;
    const rosterMax = stateAfterBid.rosterMax || ROSTER_MAX_DEFAULT;
    const rosterMin = stateAfterBid.rosterMin || ROSTER_MIN_DEFAULT;

    if (counts.SS > caps.SS) return { ok: false, reason: `Exceeds the ${caps.SS} SS-player limit for your team.` };
    if (counts.S > caps.S) return { ok: false, reason: `Exceeds the ${caps.S} S-player limit for your team.` };
    if (counts.A > caps.A) return { ok: false, reason: `Exceeds the ${caps.A} A-player limit for your team.` };
    if (totalPlayers > rosterMax) return { ok: false, reason: `Exceeds the ${rosterMax}-player roster limit.` };

    // B/C fill the rest freely, so the only remaining question is whether
    // there's enough money left to reach the configured minimum at all —
    // worst case, every remaining slot costs the cheapest reserve (C).
    const stillNeeded = Math.max(0, rosterMin - totalPlayers);
    const minCostToFinish = stillNeeded * CHEAPEST_RESERVE;

    if (availableBudget < minCostToFinish) {
        return {
            ok: false,
            reason: `Would leave you unable to reach the ${rosterMin}-player minimum — you'd need at least ${minCostToFinish.toLocaleString()} Vollars free for ${stillNeeded} more player(s), but only ${Math.max(0, availableBudget).toLocaleString()} would remain.`
        };
    }

    return { ok: true };
}

// Full bid-legality check. Returns { ok, reason, minNextBid } — this is
// the single source of truth used by the /auction/bid route AND the
// market "ELIGIBLE" filter / badges, so a player can never be shown as
// biddable in the UI when the server would actually reject the bid.
function evaluateBid({ auctionStatus, team, player, amount, allTeams, playersById, rosterLimits }) {

    if (auctionStatus === 'paused') {
        return { ok: false, reason: 'The auction is paused — bidding is temporarily frozen.' };
    }
    if (auctionStatus !== 'live') {
        return { ok: false, reason: 'The auction is not currently live.' };
    }

    if (isManagerAccount(player, allTeams)) {
        return { ok: false, reason: 'Manager accounts cannot be bid on.' };
    }

    if (player.auctionStatus === 'sold') {
        return { ok: false, reason: 'This player has already been sold.' };
    }

    const limits = rosterLimits || { rosterMin: ROSTER_MIN_DEFAULT, rosterMax: ROSTER_MAX_DEFAULT };

    const reservePrice = getReservePriceForClass(getPlayerClass(player));
    const currentHigh = Number(player.highestBid) || 0;
    const minIncrement = getMinIncrement(currentHigh || reservePrice);

    const minNextBid = currentHigh > 0
        ? roundUpToIncrement(currentHigh + minIncrement, minIncrement)
        : reservePrice;

    if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, reason: 'Invalid bid amount.', minNextBid };
    }

    if (amount < minNextBid) {
        return { ok: false, reason: `Bid must be at least ${minNextBid.toLocaleString()} Vollars.`, minNextBid };
    }

    // Must land exactly on a valid increment step above the current bid
    // (or the reserve, if unbid) — no arbitrary +1/+2 bidding.
    const base = currentHigh > 0 ? currentHigh : reservePrice - minIncrement;
    if ((amount - base) % minIncrement !== 0) {
        return {
            ok: false,
            reason: `Bids must move in increments of ${minIncrement.toLocaleString()} Vollars (next valid bid: ${minNextBid.toLocaleString()}).`,
            minNextBid
        };
    }

    const state = computeManagerAuctionState(team, playersById, limits);

    const existingOwnBid = (team.bids || []).find(b => String(b.playerId) === String(player._id));
    const existingOwnAmount = existingOwnBid ? Number(existingOwnBid.amount) || 0 : 0;

    // All bids lock money (winning or losing). Replacing our own bid on this
    // player frees the old amount and locks the new one.
    const alreadyWinningThisPlayer = !!(existingOwnBid &&
        (player.highestBidder || '').toLowerCase() === (team.name || '').toLowerCase() &&
        Number(player.highestBid || 0) === existingOwnAmount);
    const freedFromCommitted = existingOwnAmount; // own bid always counted in committed

    // Simulate roster/budget AFTER this bid replaces any existing bid on same player.
    // Roster slot only changes if we were not already the winning bidder.
    const cls = getPlayerClass(player);
    const counts = { ...state.counts };
    let totalPlayers = state.totalPlayers;
    let committed = state.committed - freedFromCommitted + amount;

    if (!alreadyWinningThisPlayer) {
        // Becoming / staying a non-winner doesn't add a slot until we actually lead.
        // If this amount will take the lead, count the slot.
        const wouldLead = amount > (Number(player.highestBid) || 0) ||
            (amount === (Number(player.highestBid) || 0) && alreadyWinningThisPlayer);
        // Simpler: if amount > current high, we become the leader and need a slot
        // unless we already had the winning slot.
        const becomesLeader = amount > (Number(player.highestBid) || 0);
        if (becomesLeader) {
            counts[cls] = (counts[cls] || 0) + 1;
            totalPlayers += 1;
        }
    }

    const maxAffordable = state.budget - state.spent - (state.committed - freedFromCommitted);
    const availableBudget = state.budget - state.spent - committed;

    if (amount > maxAffordable) {
        return {
            ok: false,
            reason: `Bid exceeds your available budget of ${Math.max(0, maxAffordable).toLocaleString()} Vollars.`,
            minNextBid
        };
    }

    // Caps recompute from the *post-bid* SS count so a 2nd SS automatically
    // tightens S/A for the legality check.
    const postCaps = getClassCapsFromCounts(counts);
    const legality = canStillLegallyCompleteRoster({
        counts,
        caps: { SS: postCaps.SS, S: postCaps.S, A: postCaps.A },
        totalPlayers,
        availableBudget,
        rosterMin: limits.rosterMin,
        rosterMax: limits.rosterMax
    });

    if (!legality.ok) {
        return { ok: false, reason: legality.reason, minNextBid };
    }

    return { ok: true, minNextBid };
}

// --- GLOBAL MIDDLEWARE ---

app.use(async (req, res, next) => {
    try {
        const info = await getInfo();

        const players = await Player.find();

        const user = req.session.playerId
            ? await Player.findById(req.session.playerId)
            : null;

        const auctionTeams = (await AuctionTeam.find()).map(team => {
            const plain = team.toObject();

            // admin.ejs expects each auction team to expose "wonPlayers" —
            // that's just the team's current bids, renamed/shaped for the view.
            plain.id = team._id.toString();
            plain.wonPlayers = (plain.bids || []).map(bid => ({
                id: bid.playerId ? bid.playerId.toString() : "",
                name: bid.playerName || ""
            }));

            return plain;
        });

        let currentManagerTeam = null;
        let isManager = false;
        let myTeamDoc = null;

        if (user) {
            const escapedName = user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const teamDoc = await AuctionTeam.findOne({
                manager: new RegExp(`^${escapedName}$`, 'i')
            });

            if (teamDoc) {
                currentManagerTeam = teamDoc._id.toString();
                isManager = true;
                myTeamDoc = teamDoc;
            }
        }

        // Every manager account, by name — used to hide "MANAGER" players
        // from normal auction eligibility everywhere in the UI.
        const managerPlayerNames = auctionTeams
            .map(t => (t.manager || '').toLowerCase())
            .filter(Boolean);

        // Manager-only auction context: budget, roster, class slots, active
        // bids, outbid players, watchlist. Computed once here so market.ejs,
        // profile.ejs, and the AI assistant all read the exact same numbers.
        let myAuctionState = null;
        let myWatchlistPlayers = [];
        let myOutbidPlayers = [];

        if (isManager && myTeamDoc) {
            const playersById = new Map(players.map(p => [String(p._id), p]));
            const rosterLimits = getRosterLimits(info.auction);

            myAuctionState = computeManagerAuctionState(myTeamDoc, playersById, rosterLimits);

            myOutbidPlayers = myAuctionState.outbidPlayerIds
                .map(id => playersById.get(id))
                .filter(Boolean);

            myWatchlistPlayers = (user.watchlist || [])
                .map(id => playersById.get(String(id)))
                .filter(Boolean);
        }

        // Most recent auction events, for the audit log under the Auction
        // tab. Admins get the full feed; everyone else still sees a public
        // trail of bids/wins (no private budget figures leak through this).
        const auctionActivityFeed = await AuctionActivity
            .find()
            .sort({ createdAt: -1 })
            .limit(80)
            .lean();

        res.locals = {
            ...res.locals,

            players: players,

            matches: await Match.find(),

            groups: await Group.find(),

            auctionTeams: auctionTeams,

            liveLink: info.liveLink,

            leaderboards: info.leaderboards,

            records: info.records,

            stories: info.stories,

            auctionSettings: info.auction || {},

            // admin.ejs reads the auction card/status off "auctionSession" —
            // same data as auctionSettings, just under the name the view expects.
            auctionSession: info.auction || {},

            isAdmin: req.session.isAdmin || false,

            user: user,

            isManager: isManager,

            currentManagerTeam: currentManagerTeam,

            managerPlayerNames: managerPlayerNames,

            myAuctionState: myAuctionState,

            myWatchlistPlayers: myWatchlistPlayers,

            myOutbidPlayers: myOutbidPlayers,

            auctionActivityFeed: auctionActivityFeed,

            page: ""
        };

        next();

    } catch (err) {
        next(err);
    }
});

// ============================================================
// OPEN GRAPH / DISCORD EMBED HELPERS
//
// Discord (and Slack, Twitter, iMessage, etc.) don't run JavaScript when
// unfurling a link — they just read <meta property="og:..."> tags out of
// the raw HTML response. So every page needs those tags baked into its
// server-rendered HTML. These helpers build that data; the actual tags
// live in views/partials/og-meta.ejs, which needs to be included inside
// your <head> on every page (see the note further down for the one line
// to add).
// ============================================================

function absoluteUrl(req, maybeRelativePath) {
    const base = req.protocol + '://' + req.get('host');

    if (!maybeRelativePath) return base + '/images/vimgfx.png';

    if (/^https?:\/\//i.test(maybeRelativePath)) return maybeRelativePath;

    return base + (maybeRelativePath.startsWith('/') ? '' : '/') + maybeRelativePath;
}

// Generic fallback embed for any page that doesn't build its own
// (home, market, metrics, records, info, etc.) — still gives Discord
// something decent to show instead of a blank/broken embed.
function defaultOg(req, title, description) {
    return {
        ogTitle: title || 'VIM Super League',
        ogDescription:
            description ||
            'Competitive Roblox football league — player market, live matches, stats and records.',
        ogImage: absoluteUrl(req),
        ogUrl: req.protocol + '://' + req.get('host') + req.originalUrl
    };
}

// Rich per-match embed: score (or kickoff time) + competition, and the
// home team's crest as the preview image so the embed actually looks
// like "this match" rather than a generic site banner.
function buildMatchOg(req, match) {
    const details = match.details || {};

    const goalsA = parseInt(details.goalsA);
    const goalsB = parseInt(details.goalsB);

    const hasScore =
        !Number.isNaN(goalsA) &&
        !Number.isNaN(goalsB) &&
        (match.status === 'completed' || match.status === 'live');

    const competition = details.competition || 'VIM Super League';
    const teamA = match.teamA || 'Team A';
    const teamB = match.teamB || 'Team B';

    const ogTitle = `${teamA} vs ${teamB} — VIM Super League`;

    let ogDescription;

    if (hasScore) {
        const finished = match.status === 'completed' ? 'FT' : 'LIVE';
        ogDescription = `${finished}: ${teamA} ${goalsA} - ${goalsB} ${teamB} · ${competition}`;
    } else {
        const when = details.date || match.time || 'Kickoff TBC';
        ogDescription = `Upcoming fixture · ${when} · ${competition}`;
    }

    const ogImage = absoluteUrl(req, match.logoA || match.logoB);

    return {
        ogTitle,
        ogDescription,
        ogImage,
        ogUrl: req.protocol + '://' + req.get('host') + req.originalUrl
    };
}

// --- PAGES ---

app.get('/', async (req, res) => {
    res.render('index', {
        page: 'home',
        ...defaultOg(
            req,
            'VIM Super League',
            'Competitive Roblox football league — player market, live matches, stats and records.'
        )
    });
});

// Builds the Market Spotlight panel: top overall bid, highest bid per
// position, and the players with the most recent bidding activity
// ("rising"). Pure read — never mutates anything.
async function buildMarketSpotlight(players, allTeams) {

    const biddable = players.filter(p =>
        p.verified &&
        !isManagerAccount(p, allTeams) &&
        Number(p.highestBid) > 0
    );

    // Top 10 by highest bid — UI shows top 3 by default, expands to 10.
    const topBids = [...biddable]
        .sort((a, b) => Number(b.highestBid) - Number(a.highestBid))
        .slice(0, 10);

    const byPosition = {};
    const byPositionTop = {};
    for (const posKey of ['FWD', 'MID', 'DEF', 'GK']) {
        const ranked = biddable
            .filter(p => (p.position || '').toUpperCase() === posKey)
            .sort((a, b) => Number(b.highestBid) - Number(a.highestBid));
        if (ranked[0]) byPosition[posKey] = ranked[0];
        byPositionTop[posKey] = ranked.slice(0, 10);
    }

    // "Rising" = players with a recent flurry of bid activity in the last 2 hours.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const recentBids = await AuctionActivity.find({
        type: 'bid',
        createdAt: { $gte: twoHoursAgo }
    }).lean();

    const activityCount = new Map();
    for (const b of recentBids) {
        const key = String(b.playerId);
        activityCount.set(key, (activityCount.get(key) || 0) + 1);
    }

    const rising = [...activityCount.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([playerId, count]) => {
            const player = players.find(p => String(p._id) === playerId);
            return player ? { player, bidCount: count } : null;
        })
        .filter(Boolean);

    return { topBids, byPosition, byPositionTop, rising };
}

app.get('/market', async (req, res) => {
    try {
        const players = await Player.find({
            verified: true
        });

        const groups = await Group.find();

        const teams = groups.flatMap(group => group.teams || []);

        const allTeams = await AuctionTeam.find();

        const marketSpotlight = await buildMarketSpotlight(players, allTeams);

        // Per-manager eligibility, precomputed server-side so the market
        // badges/filter and the actual /auction/bid route can never
        // disagree with each other.
        let myEligibility = null;

        if (res.locals.isManager && res.locals.myAuctionState) {
            const info = await getInfo();
            const auctionStatus = (info.auction && info.auction.status) || 'ready';
            const playersById = new Map(players.map(p => [String(p._id), p]));
            const myTeam = res.locals.myAuctionState.team;
            const rosterLimits = getRosterLimits(info.auction);

            myEligibility = {};
            for (const p of players) {
                if (isManagerAccount(p, allTeams)) continue;
                const verdict = evaluateBid({
                    auctionStatus,
                    team: myTeam,
                    player: p,
                    amount: p.highestBid > 0
                        ? roundUpToIncrement(p.highestBid + getMinIncrement(p.highestBid), getMinIncrement(p.highestBid))
                        : getReservePriceForClass(getPlayerClass(p)),
                    allTeams,
                    playersById,
                    rosterLimits
                });
                myEligibility[String(p._id)] = verdict.ok;
            }
        }

        res.render('market', {
            page: 'market',
            players,
            teams,
            marketSpotlight,
            myEligibility,
            error: req.query.error || null,
            ...defaultOg(
                req,
                'Player Market — VIM Super League',
                'Browse registered player cards, stats, positions and franchise auctions.'
            )
        });

    } catch (err) {
        console.error("Market Route Error:", err);

        res.redirect('/?error=MarketLoadFailed');
    }
});

app.post('/market/view/:name', async (req, res) => {
    try {
        const player = await Player.findOne({
            name: new RegExp(`^${req.params.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
        });

        if (!player) {
            return res.json({ success: false });
        }

        const viewer = req.session.playerId || req.ip || 'anon';

        if (!Array.isArray(player.views)) {
            player.views = [];
        }

        if (!player.views.includes(viewer)) {
            player.views.push(viewer);
            await player.save();
        }

        res.json({ success: true, count: player.views.length });

    } catch (err) {
        console.error("Market View Count Error:", err);
        res.json({ success: false });
    }
});

app.get('/matches', (req, res) => {
    res.render('matches', {
        page: 'matches',
        ...defaultOg(
            req,
            'Matches — VIM Super League',
            'Upcoming fixtures, live scores and completed match results.'
        )
    });
});

app.get('/match/:id', async (req, res) => {
    const match = await Match.findById(req.params.id);

    if (!match) {
        return res.redirect('/matches');
    }

    res.render('match-details', {
        match,
        page: 'matches',
        ...buildMatchOg(req, match)
    });
});

app.get('/metrics', (req, res) => {
    res.render('metrics', {
        page: 'metrics',
        ...defaultOg(
            req,
            'Metrics — VIM Super League',
            'League-wide statistics: goals, assists, saves, MVPs and player leaderboards.'
        )
    });
});

app.get('/league-records', (req, res) => {
    res.render('league-records', {
        page: 'records',
        ...defaultOg(
            req,
            'League Records — VIM Super League',
            'Historic achievements, records and milestones from across the league.'
        )
    });
});

app.get('/info', (req, res) => {
    res.render('info', {
        page: 'info',
        ...defaultOg(req, 'Info — VIM Super League')
    });
});

app.get('/admin-login', (req, res) => {
    res.render('admin-login', {
        error: null,
        page: 'admin'
    });
});

app.get('/profile', async (req, res) => {
    if (!req.session.playerId) {
        return res.redirect('/market?error=Please login first');
    }

    let myRecentBids = [];
    try {
        myRecentBids = await AuctionActivity.find({
            type: 'bid',
            playerId: req.session.playerId
        })
            .sort({ createdAt: -1 })
            .limit(25)
            .lean();
    } catch (err) {
        console.error('Profile recent bids error:', err);
    }

    res.render('profile', {
        page: 'profile',
        error: req.query.error || null,
        myRecentBids
    });
});

app.get('/admin', async (req, res) => {
    if (!req.session.isAdmin) {
        return res.redirect('/admin-login');
    }

    // Pre-End-Auction roster check: for every enrolled team, how many
    // players are they CURRENTLY winning right now? Ending the auction
    // while a team sits below the roster minimum locks them in under-
    // sized, so this is surfaced before the admin presses End Auction.
    let rosterReadiness = [];

    try {
        const infoForRoster = await getInfo();
        const rosterLimits = getRosterLimits(infoForRoster.auction);
        const allTeams = await AuctionTeam.find();
        const allPlayers = await Player.find();
        const playersById = new Map(allPlayers.map(p => [String(p._id), p]));

        rosterReadiness = allTeams.map(team => {
            const state = computeManagerAuctionState(team, playersById, rosterLimits);
            return {
                teamId: String(team._id),
                teamName: team.name,
                manager: team.manager,
                provisionalCount: state.totalPlayers,
                availableBudget: state.availableBudget,
                belowMinimum: state.totalPlayers < rosterLimits.rosterMin,
                shortfall: Math.max(0, rosterLimits.rosterMin - state.totalPlayers)
            };
        });
    } catch (err) {
        console.error("Roster Readiness Check Error:", err);
    }

    res.render('admin', {
        page: 'admin',
        error: req.query.error || null,
        rosterReadiness
    });
});

// --- AUTH ROUTES ---

app.post('/register', async (req, res) => {

    // Registration is only blocked while the auction is LIVE.
    // Once the admin ends it (status = ended) — or before it starts (ready) —
    // new players can register again.
    const info = await getInfo();
    const auctionStatus = (info.auction && info.auction.status) || 'ready';

    if (isRegistrationClosed(auctionStatus)) {
        return res.redirect('/market?error=Player registration is closed while the auction is live or paused');
    }

    const exists = await Player.findOne({
        name: new RegExp(`^${req.body.name}$`, 'i')
    });

    if (exists) {
        return res.redirect('/market?error=Username already taken!');
    }

    const newPlayer = await Player.create({
        ...req.body
    });

    req.session.playerId = newPlayer._id;

    res.redirect('/profile');
});

app.post('/login', async (req, res) => {
    const {
        username,
        password
    } = req.body;

    const player = await Player.findOne({
        name: new RegExp(`^${username}$`, 'i'),
        password
    });

    if (player) {
        req.session.playerId = player._id;
        res.redirect('/profile');
    } else {
        res.redirect('/market?error=Invalid username or password');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// --- DISCORD AUTH ROUTES ---

app.get('/auth/discord', (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;

    if (!clientId) {
        return res.redirect(
            '/market?error=Discord Client ID not set in environment variables'
        );
    }

    const redirectUri =
        `${req.protocol}://${req.get('host')}/auth/discord/callback`;

    res.redirect(
        `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20email`
    );
});

app.get('/auth/discord/callback', async (req, res) => {
    const {
        code
    } = req.query;

    if (!code) {
        return res.redirect(
            '/market?error=Discord authorization failed'
        );
    }

    try {
        res.redirect('/profile');

    } catch (err) {
        console.error("Discord Auth Error:", err);

        res.redirect(
            '/market?error=DiscordAuthenticationFailed'
        );
    }
});

// ============================================================
// AUCTION BIDDING ROUTES
// ============================================================

async function refreshPlayerHighestBid(playerId) {
    const player = await Player.findById(playerId);

    if (!player) return;

    const teams = await AuctionTeam.find();

    let highestBid = Number(player.reservePrice) || 0;
    let highestBidder = "";

    // Losing bids are INTENTIONALLY kept. They stay on the team and keep
    // locking budget until that manager is allowed to withdraw (only if no
    // rival bid after them — i.e. they become sole high again after a
    // higher bidder withdraws) or an admin force-drops the bid.
    for (const team of teams) {
        const bid = (team.bids || []).find(
            b => b.playerId && b.playerId.toString() === playerId.toString()
        );

        if (bid && Number(bid.amount) > highestBid) {
            highestBid = Number(bid.amount);
            highestBidder = team.name;
        }
    }

    // If every bid was withdrawn, fall back to reserve with no holder.
    if (!highestBidder) {
        highestBid = Number(player.reservePrice) || 0;
    }

    player.highestBid = highestBid;
    player.highestBidder = highestBidder;
    await player.save();
}

app.post('/auction/bid', async (req, res) => {

    if (!req.session.playerId) {
        return res.redirect(
            '/market?error=Please login first'
        );
    }

    try {

        const user = await Player.findById(
            req.session.playerId
        );

        if (!user) {
            return res.redirect(
                '/market?error=Please login first'
            );
        }

        const escapedName = user.name.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
        );

        const team = await AuctionTeam.findOne({
            manager: new RegExp(
                `^${escapedName}$`,
                'i'
            )
        });

        if (!team) {
            return res.redirect(
                '/market?error=You are not assigned as a team manager!'
            );
        }

        const {
            playerId,
            bidAmount,
            teamId
        } = req.body;

        const amount = Number(bidAmount);

        if (
            teamId &&
            team._id.toString() !== teamId.toString()
        ) {
            return res.redirect(
                '/market?error=Unauthorized team'
            );
        }

        if (!playerId) {
            return res.redirect(
                '/market?error=Player not specified'
            );
        }

        const player = await Player.findById(playerId);

        if (!player) {
            return res.redirect(
                '/market?error=Player not found'
            );
        }

        const info = await getInfo();
        const auctionStatus = (info.auction && info.auction.status) || 'ready';
        const rosterLimits = getRosterLimits(info.auction);

        const allTeams = await AuctionTeam.find();
        const allPlayers = await Player.find();
        const playersById = new Map(allPlayers.map(p => [String(p._id), p]));

        const verdict = evaluateBid({
            auctionStatus,
            team,
            player,
            amount,
            allTeams,
            playersById,
            rosterLimits
        });

        if (!verdict.ok) {
            return res.redirect(
                `/market?error=${encodeURIComponent(verdict.reason)}`
            );
        }

        const existingIndex = team.bids.findIndex(
            b => b.playerId && b.playerId.toString() === playerId.toString()
        );

        if (existingIndex !== -1) {
            team.bids[existingIndex].amount = amount;
            team.bids[existingIndex].playerName = player.name;
            team.bids[existingIndex].updatedAt = new Date();
        } else {
            team.bids.push({
                playerId: player._id,
                playerName: player.name,
                amount: amount,
                updatedAt: new Date()
            });
        }

        await team.save();

        await refreshPlayerHighestBid(player._id);

        await AuctionActivity.create({
            type: 'bid',
            playerId: player._id,
            playerName: player.name,
            teamId: team._id,
            teamName: team.name,
            managerName: user.name,
            amount: amount
        });

        res.redirect('/market');

    } catch (err) {

        console.error(
            "Bid Placement/Edit Error:",
            err
        );

        res.redirect(
            '/market?error=BiddingFailed'
        );
    }
});

// --- WITHDRAW BID ---

app.post('/auction/withdraw', async (req, res) => {

    if (!req.session.playerId) {
        return res.redirect(
            '/market?error=Please login first'
        );
    }

    try {

        const user = await Player.findById(
            req.session.playerId
        );

        if (!user) {
            return res.redirect(
                '/market?error=Please login first'
            );
        }

        const {
            playerId,
            teamId
        } = req.body;

        const team =
            await AuctionTeam.findById(teamId);

        if (!team) {
            return res.redirect(
                '/market?error=Team not found'
            );
        }

        if (
            !team.manager ||
            team.manager.toLowerCase() !==
                user.name.toLowerCase()
        ) {
            return res.redirect(
                '/market?error=Unauthorized withdrawal'
            );
        }

        const info = await getInfo();
        const auctionStatus = (info.auction && info.auction.status) || 'ready';

        if (auctionStatus !== 'live') {
            return res.redirect(
                '/market?error=The auction is not currently live'
            );
        }

        const existingBid =
            team.bids.find(
                b =>
                    b.playerId &&
                    b.playerId.toString() ===
                    playerId.toString()
            );

        if (!existingBid) {
            return res.redirect(
                '/market?error=You do not have a bid on this player'
            );
        }

        // THE WITHDRAWAL RULE: a manager may withdraw ONLY if no other
        // manager has placed a bid on this player after their own most
        // recent bid. Once someone else responds, the bid is locked.
        const myLastBid = await AuctionActivity
            .findOne({ type: 'bid', playerId: playerId, teamId: team._id })
            .sort({ createdAt: -1 });

        if (myLastBid) {
            const laterRivalBid = await AuctionActivity.findOne({
                type: 'bid',
                playerId: playerId,
                teamId: { $ne: team._id },
                createdAt: { $gt: myLastBid.createdAt }
            });

            if (laterRivalBid) {
                return res.redirect(
                    '/market?error=Another manager has already bid since your last bid — this bid is now locked and cannot be withdrawn'
                );
            }
        }

        team.bids =
            team.bids.filter(
                b =>
                    !b.playerId ||
                    b.playerId.toString() !==
                        playerId.toString()
            );

        await team.save();

        const player =
            await Player.findById(playerId);

        if (player) {
            await refreshPlayerHighestBid(
                player._id
            );

            await AuctionActivity.create({
                type: 'withdraw',
                playerId: player._id,
                playerName: player.name,
                teamId: team._id,
                teamName: team.name,
                managerName: user.name,
                amount: existingBid.amount
            });
        }

        res.redirect('/market');

    } catch (err) {

        console.error(
            "Bid Withdrawal Error:",
            err
        );

        res.redirect(
            '/market?error=WithdrawFailed'
        );
    }
});

// --- WATCHLIST (private, per manager) ---

app.post('/auction/watchlist/toggle', async (req, res) => {

    if (!req.session.playerId) {
        return res.json({ success: false, error: 'Please login first' });
    }

    try {

        const user = await Player.findById(req.session.playerId);

        if (!user) {
            return res.json({ success: false, error: 'Please login first' });
        }

        const escapedName = user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const team = await AuctionTeam.findOne({
            manager: new RegExp(`^${escapedName}$`, 'i')
        });

        if (!team) {
            return res.json({ success: false, error: 'Only assigned managers have a watchlist' });
        }

        const { playerId } = req.body;

        if (!playerId) {
            return res.json({ success: false, error: 'Player not specified' });
        }

        if (!Array.isArray(user.watchlist)) {
            user.watchlist = [];
        }

        const idStr = String(playerId);
        const isWatching = user.watchlist.some(id => String(id) === idStr);

        if (isWatching) {
            user.watchlist = user.watchlist.filter(id => String(id) !== idStr);
        } else {
            user.watchlist.push(idStr);
        }

        await user.save();

        res.json({ success: true, watching: !isWatching });

    } catch (err) {
        console.error("Watchlist Toggle Error:", err);
        res.json({ success: false, error: 'WatchlistToggleFailed' });
    }
});

// --- MANAGER AUCTION CONTEXT (JSON) ---
// Powers the private manager dashboard refresh and the AI assistant's
// manager-only answers. Never returns another manager's data.

app.get('/api/manager/context', async (req, res) => {

    if (!req.session.playerId) {
        return res.status(401).json({ success: false, error: 'Please login first' });
    }

    try {

        const user = await Player.findById(req.session.playerId);

        if (!user) {
            return res.status(401).json({ success: false, error: 'Please login first' });
        }

        const escapedName = user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const team = await AuctionTeam.findOne({
            manager: new RegExp(`^${escapedName}$`, 'i')
        });

        if (!team) {
            return res.json({ success: true, isManager: false });
        }

        const info = await getInfo();
        const auctionStatus = (info.auction && info.auction.status) || 'ready';
        const rosterLimits = getRosterLimits(info.auction);

        const allPlayers = await Player.find();
        const allTeams = await AuctionTeam.find();
        const playersById = new Map(allPlayers.map(p => [String(p._id), p]));

        const state = computeManagerAuctionState(team, playersById, rosterLimits);

        const eligiblePlayers = allPlayers.filter(p => {
            if (p.auctionStatus === 'sold') return false;
            if (isManagerAccount(p, allTeams)) return false;
            if (!p.verified) return false;
            const verdict = evaluateBid({
                auctionStatus,
                team,
                player: p,
                amount: getReservePriceForClass(getPlayerClass(p)),
                allTeams,
                playersById,
                rosterLimits
            });
            return verdict.ok || (verdict.minNextBid && verdict.reason && verdict.reason.startsWith('Bid must be at least'));
        });

        const winning = state.provisional.map(({ player, amount }) => ({
            id: String(player._id),
            name: player.name,
            class: getPlayerClass(player),
            position: player.position,
            amount
        }));

        const outbid = (await Player.find({ _id: { $in: state.outbidPlayerIds } })).map(p => ({
            id: String(p._id),
            name: p.name,
            class: getPlayerClass(p),
            position: p.position,
            currentBid: p.highestBid,
            currentBidder: p.highestBidder
        }));

        const watchlist = (user.watchlist || [])
            .map(id => playersById.get(String(id)))
            .filter(Boolean)
            .map(p => ({
                id: String(p._id),
                name: p.name,
                class: getPlayerClass(p),
                position: p.position,
                currentBid: p.highestBid || getReservePriceForClass(getPlayerClass(p)),
                currentBidder: p.highestBidder || null,
                isWinning: (p.highestBidder || '').toLowerCase() === team.name.toLowerCase()
            }));

        res.json({
            success: true,
            isManager: true,
            auctionStatus,
            team: {
                name: team.name,
                budget: team.budget,
                spent: team.spent,
                availableBudget: state.availableBudget,
                committed: state.committed,
                totalPlayers: state.totalPlayers,
                rosterMin: state.rosterMin,
                rosterMax: state.rosterMax,
                counts: state.counts,
                caps: state.caps,
                remainingSlots: state.remainingSlots
            },
            winning,
            outbid,
            watchlist,
            eligibleCount: eligiblePlayers.length,
            eligiblePlayers: eligiblePlayers.slice(0, 50).map(p => ({
                id: String(p._id),
                name: p.name,
                class: getPlayerClass(p),
                position: p.position,
                currentBid: p.highestBid || getReservePriceForClass(getPlayerClass(p))
            }))
        });

    } catch (err) {
        console.error("Manager Context Error:", err);
        res.status(500).json({ success: false, error: 'ManagerContextFailed' });
    }
});

// Public: recent bid history for a single player (market modal expand + profile).
app.get('/api/player/:id/bids', async (req, res) => {
    try {
        const playerId = req.params.id;
        if (!playerId) {
            return res.json({ success: false, error: 'Missing player id' });
        }

        const bids = await AuctionActivity.find({
            type: 'bid',
            playerId: playerId
        })
            .sort({ createdAt: -1 })
            .limit(40)
            .lean();

        res.json({
            success: true,
            bids: bids.map(b => ({
                teamName: b.teamName || 'Unknown',
                managerName: b.managerName || '',
                amount: Number(b.amount) || 0,
                createdAt: b.createdAt
            }))
        });
    } catch (err) {
        console.error('Player Bids API Error:', err);
        res.status(500).json({ success: false, error: 'PlayerBidsFailed' });
    }
});

// ============================================================
// PROFILE
// ============================================================

app.post('/profile/update', async (req, res) => {

    try {

        if (!req.session.playerId) {
            return res.redirect(
                '/market?error=Please login first'
            );
        }

        const {
            bio,
            experience,
            discord,
            name,
            position,
            country,
            timezone
        } = req.body;

        await Player.findByIdAndUpdate(
            req.session.playerId,
            {
                bio,
                experience,
                discord,
                name,
                position,
                country,
                timezone
            }
        );

        res.redirect('/profile');

    } catch (err) {
        res.redirect(
            '/profile?error=Update failed'
        );
    }
});

app.post('/profile/update-theme', async (req, res) => {

    try {

        if (!req.session.playerId) {
            return res.redirect('/market');
        }

        const {
            theme
        } = req.body;

        await Player.findByIdAndUpdate(
            req.session.playerId,
            {
                theme
            }
        );

        res.redirect('/profile');

    } catch (err) {

        res.redirect(
            '/profile?error=Theme update failed'
        );
    }
});

app.post('/profile/delete', async (req, res) => {

    try {

        if (!req.session.playerId) {
            return res.redirect('/market');
        }

        await Player.findByIdAndDelete(
            req.session.playerId
        );

        req.session.destroy();

        res.redirect(
            '/market?error=Account deleted successfully'
        );

    } catch (err) {

        res.redirect(
            '/profile?error=Delete failed'
        );
    }
});

// ============================================================
// ADMIN / BROADCAST + SCHEDULE
// ============================================================

// LIVE LINK

app.post('/admin/live', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info = await getInfo();

        info.liveLink =
            req.body.link || "";

        await info.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Live Link Error:",
            err
        );

        res.redirect(
            '/admin?error=LiveLinkFailed'
        );
    }
});

// ADD MATCH

app.post('/admin/add-match', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const scheduledAt =
            parseDateTime(
                req.body.scheduledAt
            );

        await Match.create({

            teamA: req.body.teamA || "",

            teamB: req.body.teamB || "",

            logoA: req.body.logoA || "",

            logoB: req.body.logoB || "",

            time:
                req.body.time ||
                req.body.scheduledAt ||
                "",

            scheduledAt,

            timezone:
                req.body.timezone || "",

            tags:
                req.body.tags || "",

            isLive: false,

            status: 'upcoming',

            details: {}

        });

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Add Match Error:",
            err
        );

        res.redirect(
            '/admin?error=AddMatchFailed'
        );
    }
});

// UPDATE MATCH / SCHEDULE

app.post('/admin/update-match', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const scheduledAt =
            parseDateTime(
                req.body.scheduledAt
            );

        await Match.findByIdAndUpdate(
            req.body.matchId,
            {

                teamA:
                    req.body.teamA || "",

                teamB:
                    req.body.teamB || "",

                logoA:
                    req.body.logoA || "",

                logoB:
                    req.body.logoB || "",

                time:
                    req.body.time ||
                    req.body.scheduledAt ||
                    "",

                scheduledAt,

                timezone:
                    req.body.timezone || "",

                tags:
                    req.body.tags || ""

            },
            {
                new: true
            }
        );

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Update Match Error:",
            err
        );

        res.redirect(
            '/admin?error=UpdateMatchFailed'
        );
    }
});

// SET MATCH LIVE

app.post('/admin/set-match-live', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const match =
            await Match.findById(
                req.body.matchId
            );

        if (!match) {
            return res.redirect(
                '/admin?error=MatchNotFound'
            );
        }

        match.isLive = true;

        match.status = 'live';

        await match.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Set Match Live Error:",
            err
        );

        res.redirect(
            '/admin?error=SetLiveFailed'
        );
    }
});

// DELETE MATCH

app.post('/admin/delete-match', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        await Match.findByIdAndDelete(
            req.body.matchId
        );

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Delete Match Error:",
            err
        );

        res.redirect(
            '/admin?error=DeleteMatchFailed'
        );
    }
});

// ============================================================
// MATCH CENTER / LINEUPS
// ============================================================

// Fixed 7-slot formation (GK + 2 DEF + 2 MID + 2 FWD) used to place
// lineup cards on the pitch graphic. Team A attacks downward (their own
// goal sits near the top of the pitch), Team B is the mirror image.
const LINEUP_SLOTS = ['gk', 'def1', 'def2', 'mid1', 'mid2', 'fwd1', 'fwd2'];

const LINEUP_SLOT_COORDS = {
    A: {
        gk:   { x: 50, y: 8 },
        def1: { x: 18, y: 20 },
        def2: { x: 82, y: 20 },
        mid1: { x: 40, y: 32 },
        mid2: { x: 60, y: 32 },
        fwd1: { x: 20, y: 44 },
        fwd2: { x: 80, y: 44 }
    },
    B: {
        gk:   { x: 50, y: 92 },
        def1: { x: 18, y: 80 },
        def2: { x: 82, y: 80 },
        mid1: { x: 40, y: 68 },
        mid2: { x: 60, y: 68 },
        fwd1: { x: 20, y: 56 },
        fwd2: { x: 80, y: 56 }
    }
};

function lineupSlotGroup(slot) {
    if (slot === 'gk') return 'GK';
    if (slot.startsWith('def')) return 'DEF';
    if (slot.startsWith('mid')) return 'MID';
    return 'FWD';
}

// Turns the 7 raw "lineup{side}_{slot}" / "_number" / "_rating" form
// fields into the structured array match-details.ejs renders on the
// pitch (name, position group, jersey number, match rating, card image,
// and the fixed x/y coordinate for that slot).
function buildLineupPlayers(side, body, playerMap) {
    return LINEUP_SLOTS.map(slot => {

        const name = body[`lineup${side}_${slot}`];
        if (!name || !playerMap.has(name)) return null;

        const playerDoc = playerMap.get(name);
        const coords = LINEUP_SLOT_COORDS[side][slot];

        const ratingRaw = body[`lineup${side}_${slot}_rating`];
        const rating =
            ratingRaw !== undefined && ratingRaw !== null && ratingRaw !== ''
                ? parseFloat(ratingRaw)
                : null;

        const number = (body[`lineup${side}_${slot}_number`] || '').toString().trim();

        return {
            name: playerDoc.name,
            position: lineupSlotGroup(slot),
            slot,
            number,
            rating: (rating !== null && !Number.isNaN(rating)) ? rating : null,
            image: playerDoc.cardImage || '',
            x: coords.x,
            y: coords.y
        };

    }).filter(Boolean);
}

app.post('/admin/update-match-details', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            matchId
        } = req.body;

        const toArr = (val) =>
            Array.isArray(val)
                ? val
                : (val ? [val] : []);

        const teamAPlayers =
            toArr(req.body.teamAPlayer)
                .map((name, i) => ({

                    name,

                    type:
                        toArr(
                            req.body.teamAType
                        )[i] || "",

                    value:
                        toArr(
                            req.body.teamAMainValue
                        )[i] || "",

                    assists:
                        toArr(
                            req.body.teamAAssists
                        )[i] || ""

                }));

        const teamBPlayers =
            toArr(req.body.teamBPlayer)
                .map((name, i) => ({

                    name,

                    type:
                        toArr(
                            req.body.teamBType
                        )[i] || "",

                    value:
                        toArr(
                            req.body.teamBMainValue
                        )[i] || "",

                    assists:
                        toArr(
                            req.body.teamBAssists
                        )[i] || ""

                }));

        const existingMatch =
            await Match.findById(matchId);

        if (!existingMatch) {
            return res.redirect(
                '/admin?error=MatchNotFound'
            );
        }

        // Only verified players from Player DB
        // are allowed into lineups.

        const verifiedPlayers =
            await Player.find({
                verified: true
            }).select('name position cardImage');

        const validNames =
            new Set(
                verifiedPlayers.map(
                    p => p.name
                )
            );

        const validTeamAPlayers =
            teamAPlayers.filter(
                p =>
                    p.name &&
                    validNames.has(p.name)
            );

        const validTeamBPlayers =
            teamBPlayers.filter(
                p =>
                    p.name &&
                    validNames.has(p.name)
            );

        // Build the pitch-ready lineup cards (image, jersey number, match
        // rating, formation coordinates) from the 7 fixed slots per side.
        const playerMap = new Map(
            verifiedPlayers.map(p => [p.name, p])
        );

        const lineupPlayersA = buildLineupPlayers('A', req.body, playerMap);
        const lineupPlayersB = buildLineupPlayers('B', req.body, playerMap);

        existingMatch.status =
            req.body.matchStatus ||
            existingMatch.status ||
            'completed';

        existingMatch.details = {

            ...(existingMatch.details || {}),

            ...req.body,

            teamAPlayers:
                validTeamAPlayers,

            teamBPlayers:
                validTeamBPlayers,

            lineupPlayersA,

            lineupPlayersB

        };

        await existingMatch.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Match Detail Update Error:",
            err
        );

        res.redirect(
            '/admin?error=MatchUpdateFailed'
        );
    }
});

// ============================================================
// PLAYER ADMIN
// ============================================================

app.post('/admin/approve-player', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const allowedRanks = ['C', 'B', 'A', 'S', 'SS'];
        const submittedRank = (req.body.rank || '').toUpperCase();

        const updatePayload = {
            verified: true,
            cardImage:
                req.body.cardImage
        };

        const info = await getInfo();
        const auctionStatus = getAuctionStatus(info);

        if (allowedRanks.includes(submittedRank)) {
            if (isRankFrozen(auctionStatus)) {
                return res.redirect('/admin?error=Ranks are frozen while the auction is live or paused. End or keep the auction in Ready/Ended to change ranks.');
            }
            updatePayload.rank = submittedRank;
        }

        await Player.findByIdAndUpdate(
            req.body.playerId,
            updatePayload
        );

        if (allowedRanks.includes(submittedRank)) {
            await AuctionActivity.create({
                type: 'rank_change',
                playerId: req.body.playerId,
                meta: { rank: submittedRank, via: 'approval' }
            });
        }

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Approve Player Error:",
            err
        );

        res.redirect(
            '/admin?error=ApprovePlayerFailed'
        );
    }
});

app.post('/admin/update-market-player', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            username,
            goals,
            assists,
            saves,
            mvps,
            bio,
            cardImage,
            rank
        } = req.body;

        const allowedRanks = ['C', 'B', 'A', 'S', 'SS'];
        const submittedRank = (rank || '').toUpperCase();

        const updatePayload = {

            goals:
                parseInt(goals) || 0,

            assists:
                parseInt(assists) || 0,

            saves:
                parseInt(saves) || 0,

            mvps:
                parseInt(mvps) || 0,

            bio,

            cardImage

        };

        const info = await getInfo();
        const auctionStatus = getAuctionStatus(info);

        if (allowedRanks.includes(submittedRank)) {
            if (isRankFrozen(auctionStatus)) {
                return res.redirect('/admin?error=Ranks are frozen while the auction is live or paused. End or keep the auction in Ready/Ended to change ranks.');
            }
            updatePayload.rank = submittedRank;
        }

        await Player.findOneAndUpdate(
            {
                name: username
            },
            updatePayload
        );

        if (allowedRanks.includes(submittedRank)) {
            await AuctionActivity.create({
                type: 'rank_change',
                playerName: username,
                meta: { rank: submittedRank, via: 'edit' }
            });
        }

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Update Market Player Error:",
            err
        );

        res.redirect(
            '/admin?error=PlayerUpdateFailed'
        );
    }
});

// ============================================================
// GROUPS / TEAMS
// ============================================================

app.post('/admin/add-group', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        await Group.create({
            name: req.body.name,
            teams: []
        });

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Add Group Error:",
            err
        );

        res.redirect(
            '/admin?error=AddGroupFailed'
        );
    }
});

app.post('/admin/update-team', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            groupId,
            teamIndex,
            teamName,
            logo,
            mp,
            wins,
            loses,
            pts,
            budget,
            managerName
        } = req.body;

        // Existing auction-team creation behavior
        if (
            !groupId &&
            teamName &&
            budget !== undefined
        ) {

            await AuctionTeam.create({

                name: teamName,

                logo: logo || "",

                budget:
                    Number(budget) || 0,

                manager:
                    managerName || ""

            });

            return res.redirect('/admin');
        }

        const group =
            await Group.findById(groupId);

        if (group) {

            if (
                teamIndex !== "" &&
                teamIndex !== undefined &&
                group.teams[teamIndex]
            ) {

                Object.assign(
                    group.teams[teamIndex],
                    {
                        mp,
                        wins,
                        loses,
                        pts
                    }
                );

            } else if (teamName) {

                group.teams.push({

                    name: teamName,

                    logo: logo || "",

                    mp: 0,

                    wins: 0,

                    loses: 0,

                    pts: 0,

                    roster: []

                });

            }

            await group.save();
        }

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Team Update Error:",
            err
        );

        res.redirect(
            '/admin?error=TeamUpdateFailed'
        );
    }
});

// ============================================================
// AUCTION TEAM SETUP
// ============================================================

app.post('/admin/add-auction-team', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            teamName,
            logo,
            budget,
            managerName
        } = req.body;

        if (!teamName) {
            return res.redirect(
                '/admin?error=TeamNameRequired'
            );
        }

        let teamLogo =
            logo || "";

        // If this team already exists in the league,
        // automatically use its existing logo.

        if (!teamLogo) {

            const groups =
                await Group.find();

            for (const group of groups) {

                const team =
                    (group.teams || [])
                        .find(
                            t =>
                                t.name ===
                                teamName
                        );

                if (team) {

                    teamLogo =
                        team.logo || "";

                    break;
                }
            }
        }

        const existing =
            await AuctionTeam.findOne({
                name: teamName
            });

        if (existing) {

            existing.logo =
                teamLogo;

            existing.budget =
                Number(budget) ||
                existing.budget ||
                STARTING_BUDGET;

            existing.manager =
                managerName ||
                existing.manager ||
                "";

            await existing.save();

            return res.redirect('/admin');
        }

        await AuctionTeam.create({

            name: teamName,

            logo: teamLogo,

            budget:
                Number(budget) || STARTING_BUDGET,

            manager:
                managerName || "",

            spent: 0,

            bids: [],

            roster: []

        });

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Add Auction Team Error:",
            err
        );

        res.redirect(
            '/admin?error=AddAuctionTeamFailed'
        );
    }
});

app.post('/admin/delete-auction-team', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        await AuctionTeam.findByIdAndDelete(
            req.body.teamId
        );

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Delete Auction Team Error:",
            err
        );

        res.redirect(
            '/admin?error=DeleteAuctionTeamFailed'
        );
    }
});

// ============================================================
// TEAM DETAILS
// ============================================================

app.get('/team/:groupId/:teamIndex', async (req, res) => {

    try {

        const {
            groupId,
            teamIndex
        } = req.params;

        const group =
            await Group.findById(groupId);

        if (
            !group ||
            !group.teams[teamIndex]
        ) {
            return res.redirect(
                '/metrics?error=Team not found'
            );
        }

        const team =
            group.teams[teamIndex];

        res.render(
            'team-details',
            {
                team,
                group,
                page: 'metrics'
            }
        );

    } catch (err) {

        console.error(
            "Team Page Error:",
            err
        );

        res.redirect('/metrics');
    }
});

// ============================================================
// LEAGUE ROSTER
// ============================================================

app.post('/admin/add-to-roster', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            groupId,
            teamIndex,
            playerId,
            isManager
        } = req.body;

        // The dropdown in admin.ejs submits the Player's Mongo _id
        // as "playerId" — look them up by id, not by name.
        const player =
            await Player.findById(playerId);

        if (!player || !player.verified) {
            return res.redirect(
                '/admin?error=PlayerNotFound'
            );
        }

        const group =
            await Group.findById(groupId);

        if (
            group &&
            group.teams[teamIndex]
        ) {

            const roster =
                group.teams[teamIndex].roster ||
                [];

            const alreadyExists =
                roster.some(
                    p =>
                        p &&
                        p.name &&
                        p.name.toLowerCase() ===
                        player.name.toLowerCase()
                );

            if (!alreadyExists) {

                group.teams[teamIndex].roster.push({

                    name: player.name,

                    isManager:
                        isManager === "true"

                });

                group.markModified(
                    `teams.${teamIndex}.roster`
                );

                await group.save();
            }
        }

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Add To Roster Error:",
            err
        );

        res.redirect(
            '/admin?error=AddRosterFailed'
        );
    }
});

app.post('/admin/delete-from-roster', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            groupId,
            teamIndex,
            playerIndex
        } = req.body;

        const group =
            await Group.findById(groupId);

        if (
            group &&
            group.teams[teamIndex] &&
            group.teams[teamIndex].roster
        ) {

            group.teams[teamIndex]
                .roster
                .splice(
                    playerIndex,
                    1
                );

            group.markModified(
                `teams.${teamIndex}.roster`
            );

            await group.save();
        }

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Roster Delete Error:",
            err
        );

        res.redirect(
            '/admin?error=RosterDeleteFailed'
        );
    }
});

// ============================================================
// STORIES
// ============================================================

app.post('/admin/add-story', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info =
            await getInfo();

        info.stories.push({

            ...req.body,

            id:
                Date.now().toString(),

            date:
                new Date()
                    .toLocaleDateString()

        });

        await info.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Add Story Error:",
            err
        );

        res.redirect(
            '/admin?error=AddStoryFailed'
        );
    }
});

// ============================================================
// HALL OF FAME
// ============================================================

app.post('/admin/add-record', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info =
            await getInfo();

        info.records.push({

            id:
                Date.now().toString(),

            category:
                req.body.category ||
                "season",

            recordType:
                req.body.recordType ||
                "Custom",

            season:
                req.body.season ||
                "",

            competition:
                req.body.competition ||
                "",

            title:
                req.body.title ||
                "",

            holder:
                req.body.holder ||
                "",

            value:
                req.body.value ||
                "",

            description:
                req.body.description ||
                ""

        });

        info.markModified(
            'records'
        );

        await info.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Add Record Error:",
            err
        );

        res.redirect(
            '/admin?error=AddRecordFailed'
        );
    }
});

// UPDATE RECORD

app.post('/admin/update-record', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info =
            await getInfo();

        const record =
            info.records.find(
                r =>
                    String(r.id) ===
                    String(req.body.recordId)
            );

        if (!record) {
            return res.redirect(
                '/admin?error=RecordNotFound'
            );
        }

        record.category =
            req.body.category ||
            "season";

        record.recordType =
            req.body.recordType ||
            "Custom";

        record.season =
            req.body.season ||
            "";

        record.competition =
            req.body.competition ||
            "";

        record.title =
            req.body.title ||
            "";

        record.holder =
            req.body.holder ||
            "";

        record.value =
            req.body.value ||
            "";

        record.description =
            req.body.description ||
            "";

        info.markModified(
            'records'
        );

        await info.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Update Record Error:",
            err
        );

        res.redirect(
            '/admin?error=UpdateRecordFailed'
        );
    }
});

// DELETE RECORD

app.post('/admin/delete-record', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info =
            await getInfo();

        info.records =
            info.records.filter(
                r =>
                    String(r.id) !==
                    String(req.body.recordId)
            );

        info.markModified(
            'records'
        );

        await info.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Delete Record Error:",
            err
        );

        res.redirect(
            '/admin?error=DeleteRecordFailed'
        );
    }
});

// ============================================================
// LEADERBOARDS
// ============================================================

app.post('/admin/update-stat', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            type,
            statIndex,
            playerName,
            value
        } = req.body;

        const info =
            await getInfo();

        if (!info.leaderboards[type]) {
            return res.redirect(
                '/admin?error=InvalidStatType'
            );
        }

        if (
            statIndex !== "" &&
            statIndex !== undefined &&
            info.leaderboards[type][statIndex]
        ) {

            info.leaderboards[type]
                [statIndex]
                .value = value;

        } else {

            info.leaderboards[type].push({
                name: playerName,
                value
            });
        }

        info.leaderboards[type].sort(
            (a, b) =>
                Number(b.value) -
                Number(a.value)
        );

        info.markModified(
            'leaderboards'
        );

        await info.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Update Stat Error:",
            err
        );

        res.redirect(
            '/admin?error=UpdateStatFailed'
        );
    }
});

app.post('/admin/delete-stat', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            type,
            index
        } = req.body;

        const info =
            await getInfo();

        if (info.leaderboards[type]) {

            info.leaderboards[type]
                .splice(
                    index,
                    1
                );

            info.markModified(
                'leaderboards'
            );

            await info.save();
        }

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Delete Stat Error:",
            err
        );

        res.redirect(
            '/admin?error=DeleteStatFailed'
        );
    }
});

// ============================================================
// AUCTION CONTROL
// ============================================================

// GLOBAL AUCTION START / END + MAX SQUAD SIZE

app.post('/admin/auction/update-session', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info =
            await getInfo();

        const maxRosterSize =
            Math.max(
                1,
                parseInt(
                    req.body.maxRosterSize,
                    10
                ) || ROSTER_MAX_DEFAULT
            );

        const minRosterSize =
            Math.max(
                1,
                Math.min(
                    maxRosterSize,
                    parseInt(
                        req.body.minRosterSize,
                        10
                    ) || ROSTER_MIN_DEFAULT
                )
            );

        const existingAuction =
            info.auction || {};

        info.auction = {

            name:
                req.body.name || existingAuction.name || "VSL Auction",

            maxRosterSize,

            minRosterSize,

            status:
                existingAuction.status || "ready",

            sessionStartedAt:
                existingAuction.sessionStartedAt || null,

            sessionEndedAt:
                existingAuction.sessionEndedAt || null

        };

        info.markModified(
            'auction'
        );

        await info.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Auction Session Update Error:",
            err
        );

        res.redirect(
            '/admin?error=AuctionSessionUpdateFailed'
        );
    }
});

// START AUCTION SESSION
//
// 1. Registration closes only while status is live (enforced in /register).
// 2. Reserve prices are assigned from each verified player's class.
// 3. Every player is reset to "available" so a re-run never carries over
//    stale sold/bid state from a previous session.
// (Ratings remain editable by admin at all times.)

// SAFETY VALVE: undo an accidental/test "Start Auction" and go back to
// "ready". Deliberately refuses to touch an already-ENDED auction
// (players sold, budgets deducted) — that's a real result, not something
// a button should silently unwind.
app.post('/admin/auction/reset', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info = await getInfo();
        info.auction = info.auction || {};

        if (info.auction.status === 'ended') {
            return res.redirect('/admin?error=Cannot reset an auction that has already ended — players have been sold and budgets deducted. Fix mistakes directly instead.');
        }

        info.auction.status = 'ready';
        info.auction.sessionStartedAt = null;
        info.auction.sessionEndedAt = null;
        info.markModified('auction');
        await info.save();

        await AuctionActivity.create({
            type: 'auction_start',
            meta: { reset: true }
        });

        res.redirect('/admin');

    } catch (err) {
        console.error("Reset Auction Session Error:", err);
        res.redirect('/admin?error=ResetAuctionSessionFailed');
    }
});

// RESET TOP BIDS / AUCTION LEADERBOARD
// Clears live bid amounts on every still-available player and empties every
// team's active bid list so Market Spotlight (top bids / rising) starts fresh.
// Does NOT touch sold players, spent budgets, or final rosters.
app.post('/admin/auction/reset-bids', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const allTeams = await AuctionTeam.find();
        const players = await Player.find({
            verified: true,
            auctionStatus: { $ne: 'sold' }
        });

        let clearedPlayers = 0;
        for (const player of players) {
            if (isManagerAccount(player, allTeams)) continue;
            if (Number(player.highestBid) > 0 || player.highestBidder) {
                player.highestBid = 0;
                player.highestBidder = '';
                await player.save();
                clearedPlayers++;
            }
        }

        for (const team of allTeams) {
            if ((team.bids || []).length > 0) {
                team.bids = [];
                await team.save();
            }
        }

        // Clear recent bid activity so "Rising" board also empties.
        await AuctionActivity.deleteMany({ type: 'bid' });

        await AuctionActivity.create({
            type: 'auction_start',
            meta: { resetBids: true, playersCleared: clearedPlayers }
        });

        res.redirect('/admin');

    } catch (err) {
        console.error('Reset Top Bids Error:', err);
        res.redirect('/admin?error=ResetTopBidsFailed');
    }
});


// PAUSE AUCTION — freezes bids, registration, and rank edits. Does not finalize.
app.post('/admin/auction/pause', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const info = await getInfo();
        info.auction = info.auction || {};
        if (info.auction.status !== 'live') {
            return res.redirect('/admin?error=Can only pause a live auction');
        }
        info.auction.status = 'paused';
        info.markModified('auction');
        await info.save();
        res.redirect('/admin');
    } catch (err) {
        console.error('Pause Auction Error:', err);
        res.redirect('/admin?error=PauseAuctionFailed');
    }
});

// RESUME AUCTION — paused → live
app.post('/admin/auction/resume', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const info = await getInfo();
        info.auction = info.auction || {};
        if (info.auction.status !== 'paused') {
            return res.redirect('/admin?error=Can only resume a paused auction');
        }
        info.auction.status = 'live';
        info.markModified('auction');
        await info.save();
        res.redirect('/admin');
    } catch (err) {
        console.error('Resume Auction Error:', err);
        res.redirect('/admin?error=ResumeAuctionFailed');
    }
});

// FORCE-DROP a single bid (admin mercy / correction). Then recompute highest.
app.post('/admin/auction/force-drop-bid', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { teamId, playerId } = req.body;
        if (!teamId || !playerId) {
            return res.redirect('/admin?error=Team and player are required to drop a bid');
        }
        const team = await AuctionTeam.findById(teamId);
        if (!team) return res.redirect('/admin?error=Team not found');

        const before = (team.bids || []).length;
        const dropped = (team.bids || []).find(b => b.playerId && String(b.playerId) === String(playerId));
        team.bids = (team.bids || []).filter(b => !(b.playerId && String(b.playerId) === String(playerId)));
        if (team.bids.length === before) {
            return res.redirect('/admin?error=That team has no bid on this player');
        }
        await team.save();
        await refreshPlayerHighestBid(playerId);

        const player = await Player.findById(playerId);
        await AuctionActivity.create({
            type: 'withdraw',
            playerId,
            playerName: (player && player.name) || (dropped && dropped.playerName) || '',
            teamId: team._id,
            teamName: team.name,
            managerName: 'ADMIN',
            amount: dropped ? dropped.amount : 0,
            meta: { forced: true }
        });

        res.redirect('/admin');
    } catch (err) {
        console.error('Force Drop Bid Error:', err);
        res.redirect('/admin?error=ForceDropBidFailed');
    }
});

app.post('/admin/auction/start', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info =
            await getInfo();

        info.auction =
            info.auction || {};

        if (info.auction.status === 'live') {
            return res.redirect('/admin?error=Auction is already live');
        }

        const verifiedPlayers = await Player.find({ verified: true });
        const allTeams = await AuctionTeam.find();

        for (const player of verifiedPlayers) {

            if (isManagerAccount(player, allTeams)) {
                // Manager accounts are never auctionable — leave them alone.
                continue;
            }

            const cls = getPlayerClass(player);

            player.reservePrice = getReservePriceForClass(cls);
            player.highestBid = 0;
            player.highestBidder = "";
            player.auctionStatus = "available";
            player.soldPrice = 0;
            player.soldToTeam = "";

            await player.save();
        }

        info.auction.status = "live";
        info.auction.sessionStartedAt = new Date();
        info.auction.sessionEndedAt = null;

        info.markModified('auction');
        await info.save();

        await AuctionActivity.create({
            type: 'auction_start',
            meta: { playersReset: verifiedPlayers.length }
        });

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Start Auction Session Error:",
            err
        );

        res.redirect(
            '/admin?error=StartAuctionSessionFailed'
        );
    }
});

// END AUCTION SESSION
//
// Atomically finalizes every player's actual highest bidder as the winner:
// deducts the winning team's budget, adds the player to that team's
// roster, marks the player sold, and locks the whole auction. Players
// that never received a bid simply stay "available" and unsold.
//
// This is intentionally sequential (not parallel Promise.all) so two
// players being won by the same team can't race each other's budget
// deduction, and guarded by an immediate status flip so a double-click
// on "End Auction" can't process everything twice.

app.post('/admin/auction/end', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info = await getInfo();
        info.auction = info.auction || {};

        if (info.auction.status !== 'live' && info.auction.status !== 'paused') {
            return res.redirect('/admin?error=Auction must be live (or paused) to end');
        }

        // Hard gate: every enrolled team must hold at least minRosterSize
        // provisional players (manager + current winning bids) before End.
        const rosterLimits = getRosterLimits(info.auction);
        const allTeamsCheck = await AuctionTeam.find();
        const allPlayersCheck = await Player.find();
        const playersByIdCheck = new Map(allPlayersCheck.map(p => [String(p._id), p]));
        const shortTeams = [];
        for (const team of allTeamsCheck) {
            const state = computeManagerAuctionState(team, playersByIdCheck, rosterLimits);
            if (state.totalPlayers < rosterLimits.rosterMin) {
                shortTeams.push(`${team.name} (${state.totalPlayers}/${rosterLimits.rosterMin})`);
            }
        }
        if (shortTeams.length > 0) {
            return res.redirect('/admin?error=' + encodeURIComponent(
                `Cannot end yet — ${shortTeams.length} team(s) below the ${rosterLimits.rosterMin}-player minimum: ${shortTeams.join(', ')}`
            ));
        }

        // Flip immediately so a repeat request (double click, retry) is a
        // no-op instead of re-processing every player a second time.
        info.auction.status = 'processing';
        info.markModified('auction');
        await info.save();

        const allTeams = await AuctionTeam.find();
        const teamsById = new Map(allTeams.map(t => [String(t._id), t]));

        const players = await Player.find({
            verified: true,
            auctionStatus: { $ne: 'sold' },
            highestBid: { $gt: 0 },
            highestBidder: { $ne: "" }
        });

        let assignedCount = 0;

        for (const player of players) {

            if (isManagerAccount(player, allTeams)) continue;

            const winningTeam = allTeams.find(
                t => (t.name || '').toLowerCase() === (player.highestBidder || '').toLowerCase()
            );

            if (!winningTeam) continue;

            // Re-fetch fresh so sequential wins for the same team stack
            // correctly onto the roster/spent totals already written.
            const freshTeam = await AuctionTeam.findById(winningTeam._id);
            if (!freshTeam) continue;

            const cls = getPlayerClass(player);
            const price = Number(player.highestBid) || 0;

            freshTeam.roster.push({
                name: player.name,
                position: player.position || "FWD",
                rank: cls,
                boughtFor: price
            });

            freshTeam.spent = Number(freshTeam.spent || 0) + price;

            // Clear the winning bid out of this team's active bids array —
            // it's now a roster slot, not a live bid.
            freshTeam.bids = (freshTeam.bids || []).filter(
                b => String(b.playerId) !== String(player._id)
            );

            await freshTeam.save();

            player.auctionStatus = 'sold';
            player.soldPrice = price;
            player.soldToTeam = freshTeam.name;
            await player.save();

            await AuctionActivity.create({
                type: 'won',
                playerId: player._id,
                playerName: player.name,
                teamId: freshTeam._id,
                teamName: freshTeam.name,
                managerName: freshTeam.manager,
                amount: price
            });

            assignedCount++;
        }

        // Any bid left dangling on a team for a player who DIDN'T end up
        // "sold" to them (i.e. they were outbid but the record never
        // refreshed) is stale — clear all remaining bids now that the
        // auction is closed. Also ensure the assigned manager is on the
        // final roster (they occupy a free slot and count toward class caps).
        for (const team of await AuctionTeam.find()) {
            let dirty = false;

            if ((team.bids || []).length > 0) {
                team.bids = [];
                dirty = true;
            }

            if (team.manager) {
                const mgrLower = String(team.manager).toLowerCase();
                const alreadyOnRoster = (team.roster || []).some(
                    r => (r.name || '').toLowerCase() === mgrLower
                );
                if (!alreadyOnRoster) {
                    const mgrPlayer = await Player.findOne({
                        name: new RegExp(`^${team.manager.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
                    });
                    team.roster = team.roster || [];
                    team.roster.unshift({
                        name: team.manager,
                        position: (mgrPlayer && mgrPlayer.position) || 'MID',
                        rank: getPlayerClass(mgrPlayer || { rank: 'C' }),
                        boughtFor: 0
                    });
                    dirty = true;
                }
            }

            if (dirty) await team.save();
        }

        // Sync every team's final roster into the actual League Team
        // roster, same as the old manual finalize step used to.
        const groups = await Group.find();

        for (const team of await AuctionTeam.find()) {

            const matchingGroup = groups.find(
                g => (g.teams || []).some(t => t.name === team.name)
            );

            if (!matchingGroup) continue;

            const teamIndex = matchingGroup.teams.findIndex(t => t.name === team.name);
            if (teamIndex === -1) continue;

            matchingGroup.teams[teamIndex].roster = team.roster.map(p => ({
                name: p.name,
                isManager: p.name.toLowerCase() === String(team.manager || "").toLowerCase()
            }));

            matchingGroup.markModified(`teams.${teamIndex}.roster`);
            await matchingGroup.save();
        }

        info.auction.status = 'ended';
        info.auction.sessionEndedAt = new Date();
        info.markModified('auction');
        await info.save();

        await AuctionActivity.create({
            type: 'auction_end',
            meta: { playersAssigned: assignedCount }
        });

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "End Auction Session Error:",
            err
        );

        // If something blew up mid-way, don't leave the auction stuck on
        // "processing" forever — fall back to "live" so the admin can see
        // the error and safely retry (already-sold players are skipped
        // automatically thanks to the auctionStatus filter above).
        try {
            const info = await getInfo();
            if (info.auction && info.auction.status === 'processing') {
                info.auction.status = 'live';
                info.markModified('auction');
                await info.save();
            }
        } catch (_) {}

        res.redirect(
            '/admin?error=EndAuctionSessionFailed'
        );
    }
});


// ============================================================
// FINALIZE AUCTION ROSTER
// ============================================================

app.post('/admin/auction/finalize-roster', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const team =
            await AuctionTeam.findById(
                req.body.teamId
            );

        if (!team) {
            return res.redirect(
                '/admin?error=AuctionTeamNotFound'
            );
        }

        const info =
            await getInfo();

        const maxSquadSize =
            Math.max(
                1,
                Number(
                    info.auction &&
                    info.auction.maxRosterSize
                ) || ROSTER_MAX_DEFAULT
            );

        // The checkboxes on the roster-selection form are named
        // "selectedPlayers[]", so the browser sends that exact key —
        // fall back to a plain "selectedPlayers" in case that ever changes.
        const selected =
            req.body['selectedPlayers[]'] !== undefined
                ? req.body['selectedPlayers[]']
                : req.body.selectedPlayers;

        const selectedIds =
            Array.isArray(selected)
                ? selected
                : (
                    selected
                        ? [selected]
                        : []
                );

        const won =
            Array.isArray(team.bids)
                ? team.bids
                : [];

        let chosenBids;

        if (
            req.body.autoFinalize ===
            "true"
        ) {

            chosenBids =
                won.slice(
                    0,
                    maxSquadSize
                );

        } else {

            chosenBids =
                won
                    .filter(
                        b =>
                            selectedIds.includes(
                                String(
                                    b.playerId
                                )
                            )
                    )
                    .slice(
                        0,
                        maxSquadSize
                    );
        }

        team.roster = [];

        for (
            const bid of chosenBids
        ) {

            const player =
                bid.playerId
                    ? await Player.findById(
                        bid.playerId
                    )
                    : null;

            if (!player) continue;

            team.roster.push({

                name:
                    player.name,

                position:
                    player.position ||
                    "FWD",

                boughtFor:
                    Number(
                        bid.amount
                    ) || 0

            });
        }

        team.spent =
            team.roster.reduce(
                (sum, p) =>
                    sum +
                    (
                        Number(
                            p.boughtFor
                        ) || 0
                    ),
                0
            );

        await team.save();

        // Sync auction roster into
        // the actual League Team roster.

        const groups =
            await Group.find();

        const matchingGroup =
            groups.find(
                g =>
                    (g.teams || [])
                        .some(
                            t =>
                                t.name ===
                                team.name
                        )
            );

        if (matchingGroup) {

            const teamIndex =
                matchingGroup.teams.findIndex(
                    t =>
                        t.name ===
                        team.name
                );

            if (teamIndex !== -1) {

                matchingGroup
                    .teams[teamIndex]
                    .roster =
                    team.roster.map(
                        p => ({

                            name:
                                p.name,

                            isManager:
                                p.name.toLowerCase() ===
                                String(
                                    team.manager || ""
                                ).toLowerCase()

                        })
                    );

                matchingGroup.markModified(
                    `teams.${teamIndex}.roster`
                );

                await matchingGroup.save();
            }
        }

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Finalize Auction Roster Error:",
            err
        );

        res.redirect(
            '/admin?error=FinalizeAuctionRosterFailed'
        );
    }
});

// ============================================================
// DELETE ROUTES
// ============================================================

app.post('/admin/delete-player', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        await Player.findByIdAndDelete(
            req.body.playerId
        );

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Delete Player Error:",
            err
        );

        res.redirect(
            '/admin?error=DeletePlayerFailed'
        );
    }
});

app.post('/admin/delete-story', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            storyIndex
        } = req.body;

        const info =
            await getInfo();

        if (
            info.stories &&
            info.stories[storyIndex] !==
                undefined
        ) {

            info.stories.splice(
                storyIndex,
                1
            );

            info.markModified(
                'stories'
            );

            await info.save();
        }

        res.redirect('/admin');

    } catch (err) {

        console.error(
            err
        );

        res.redirect(
            '/admin?error=DeleteStoryFailed'
        );
    }
});

app.post('/admin/delete-team', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const {
            groupId,
            teamIndex
        } = req.body;

        const group =
            await Group.findById(
                groupId
            );

        if (
            group &&
            group.teams[teamIndex]
        ) {

            group.teams.splice(
                teamIndex,
                1
            );

            await group.save();
        }

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Delete Team Error:",
            err
        );

        res.redirect(
            '/admin?error=DeleteTeamFailed'
        );
    }
});

app.post('/admin/delete-group', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        await Group.findByIdAndDelete(
            req.body.groupId
        );

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "Delete Group Error:",
            err
        );

        res.redirect(
            '/admin?error=DeleteGroupFailed'
        );
    }
});

// ============================================================
// ADMIN LOGIN
// ============================================================

app.post('/admin-login', (req, res) => {

    if (
        req.body.password ===
        ADMIN_KEY
    ) {

        req.session.isAdmin =
            true;

        res.redirect('/admin');

    } else {

        res.render(
            'admin-login',
            {
                error: "WRONG KEY!",
                page: 'admin'
            }
        );
    }
});

// ============================================================
// START SERVER
// ============================================================

app.listen(
    process.env.PORT || 3000,
    () =>
        console.log(
            "VIM Hub Active"
        )
);
