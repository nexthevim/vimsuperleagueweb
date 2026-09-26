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
    country: { type: String, default: "" },
    timezone: { type: String, default: "" },
    theme: { type: String, default: "blue" },
    experience: String,
    bio: String,
    views: [String],

    reservePrice: { type: Number, default: 0 },
    highestBid: { type: Number, default: 0 },
    highestBidder: { type: String, default: "" },

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
        amount: Number
    }],
    roster: [{
        name: String,
        position: String,
        boughtFor: Number
    }]
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
        name: { type: String, default: "VIM Auction" },
        maxRosterSize: { type: Number, default: 7 },
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

        if (user) {
            const escapedName = user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const teamDoc = await AuctionTeam.findOne({
                manager: new RegExp(`^${escapedName}$`, 'i')
            });

            if (teamDoc) {
                currentManagerTeam = teamDoc._id.toString();
                isManager = true;
            }
        }

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

            page: ""
        };

        next();

    } catch (err) {
        next(err);
    }
});

// --- PAGES ---

app.get('/', async (req, res) => {
    res.render('index', {
        page: 'home'
    });
});

app.get('/market', async (req, res) => {
    try {
        const players = await Player.find({
            verified: true
        });

        const groups = await Group.find();

        const teams = groups.flatMap(group => group.teams || []);

        res.render('market', {
            page: 'market',
            players,
            teams,
            error: req.query.error || null
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
        page: 'matches'
    });
});

app.get('/match/:id', async (req, res) => {
    const match = await Match.findById(req.params.id);

    if (!match) {
        return res.redirect('/matches');
    }

    res.render('match-details', {
        match,
        page: 'matches'
    });
});

app.get('/metrics', (req, res) => {
    res.render('metrics', {
        page: 'metrics'
    });
});

app.get('/league-records', (req, res) => {
    res.render('league-records', {
        page: 'records'
    });
});

app.get('/info', (req, res) => {
    res.render('info', {
        page: 'info'
    });
});

app.get('/admin-login', (req, res) => {
    res.render('admin-login', {
        error: null,
        page: 'admin'
    });
});

app.get('/profile', (req, res) => {
    if (!req.session.playerId) {
        return res.redirect('/market?error=Please login first');
    }

    res.render('profile', {
        page: 'profile',
        error: req.query.error || null
    });
});

app.get('/admin', (req, res) => {
    if (!req.session.isAdmin) {
        return res.redirect('/admin-login');
    }

    res.render('admin', {
        page: 'admin',
        error: req.query.error || null
    });
});

// --- AUTH ROUTES ---

app.post('/register', async (req, res) => {
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

    for (const team of teams) {

        const bid = team.bids.find(
            b =>
                b.playerId &&
                b.playerId.toString() === playerId.toString()
        );

        if (
            bid &&
            Number(bid.amount) > highestBid
        ) {
            highestBid = Number(bid.amount);
            highestBidder = team.name;
        }
    }

    player.highestBid = highestBid;
    player.highestBidder = highestBidder;

    await player.save();
}

// --- PLACE / EDIT BID ---

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

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            return res.redirect(
                '/market?error=Invalid bid amount'
            );
        }

        const player = await Player.findById(playerId);

        if (!player) {
            return res.redirect(
                '/market?error=Player not found'
            );
        }

        const reservePrice =
            Number(player.reservePrice) || 0;

        if (amount < reservePrice) {
            return res.redirect(
                `/market?error=Bid must be at least the reserve price of ${reservePrice} Vollars`
            );
        }

        const existingIndex =
            team.bids.findIndex(
                b =>
                    b.playerId &&
                    b.playerId.toString() === playerId.toString()
            );

        const allTeams =
            await AuctionTeam.find();

        let highestOtherBid = 0;

        for (const otherTeam of allTeams) {

            if (
                otherTeam._id.toString() ===
                team._id.toString()
            ) {
                continue;
            }

            const otherBid =
                otherTeam.bids.find(
                    b =>
                        b.playerId &&
                        b.playerId.toString() ===
                        playerId.toString()
                );

            if (
                otherBid &&
                Number(otherBid.amount) >
                    highestOtherBid
            ) {
                highestOtherBid =
                    Number(otherBid.amount);
            }
        }

        const minimumRequired =
            Math.max(
                reservePrice,
                highestOtherBid + 1
            );

        if (amount < minimumRequired) {
            return res.redirect(
                `/market?error=Bid must be at least ${minimumRequired} Vollars`
            );
        }

        let reservedByOtherBids = 0;

        for (const bid of team.bids) {

            if (
                bid.playerId &&
                bid.playerId.toString() !==
                    playerId.toString()
            ) {
                reservedByOtherBids +=
                    Number(bid.amount) || 0;
            }
        }

        const availableBudget =
            Number(team.budget || 0) -
            Number(team.spent || 0) -
            reservedByOtherBids;

        if (amount > availableBudget) {
            return res.redirect(
                `/market?error=Bid exceeds your available budget of ${availableBudget} Vollars`
            );
        }

        if (existingIndex !== -1) {

            team.bids[existingIndex].amount =
                amount;

            team.bids[existingIndex].playerName =
                player.name;

        } else {

            team.bids.push({
                playerId: player._id,
                playerName: player.name,
                amount: amount
            });

        }

        await team.save();

        await refreshPlayerHighestBid(
            player._id
        );

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
        gk:   { x: 50, y: 10 },
        def1: { x: 26, y: 27 },
        def2: { x: 74, y: 27 },
        mid1: { x: 30, y: 42 },
        mid2: { x: 70, y: 42 },
        fwd1: { x: 37, y: 47 },
        fwd2: { x: 63, y: 47 }
    },
    B: {
        gk:   { x: 50, y: 90 },
        def1: { x: 26, y: 73 },
        def2: { x: 74, y: 73 },
        mid1: { x: 30, y: 58 },
        mid2: { x: 70, y: 58 },
        fwd1: { x: 37, y: 53 },
        fwd2: { x: 63, y: 53 }
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

        await Player.findByIdAndUpdate(
            req.body.playerId,
            {
                verified: true,
                cardImage:
                    req.body.cardImage
            }
        );

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
            cardImage
        } = req.body;

        await Player.findOneAndUpdate(
            {
                name: username
            },
            {

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

            }
        );

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
                0;

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
                Number(budget) || 0,

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
                ) || 7
            );

        const existingAuction =
            info.auction || {};

        info.auction = {

            name:
                req.body.name || existingAuction.name || "VIM Auction",

            maxRosterSize,

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

app.post('/admin/auction/start', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info =
            await getInfo();

        info.auction =
            info.auction || {};

        info.auction.status =
            "live";

        info.auction.sessionStartedAt =
            new Date();

        info.markModified(
            'auction'
        );

        await info.save();

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

app.post('/admin/auction/end', async (req, res) => {

    if (!requireAdmin(req, res)) return;

    try {

        const info =
            await getInfo();

        info.auction =
            info.auction || {};

        info.auction.status =
            "ended";

        info.auction.sessionEndedAt =
            new Date();

        info.markModified(
            'auction'
        );

        await info.save();

        res.redirect('/admin');

    } catch (err) {

        console.error(
            "End Auction Session Error:",
            err
        );

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
                ) || 7
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
