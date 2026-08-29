import express from "express";
import Database from "better-sqlite3";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const db = new Database("jaslin.db");

const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_USERNAME = process.env.BOT_USERNAME || "JaslinGameBot";

const MINING_PER_MINUTE =
  Number(process.env.MINING_PER_MINUTE || 0.045);

const DAILY_SPIN_REWARD =
  Number(process.env.DAILY_SPIN_REWARD || 25);

const REFERRAL_REWARD =
  Number(process.env.REFERRAL_REWARD || 10);

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/* =========================================
   DATABASE
========================================= */

db.exec(`
CREATE TABLE IF NOT EXISTS users (

    telegram_id TEXT PRIMARY KEY,

    username TEXT,

    first_name TEXT,

    wallet TEXT,

    balance REAL NOT NULL DEFAULT 0,

    mining_started_at INTEGER NOT NULL,

    last_spin_at INTEGER NOT NULL DEFAULT 0,

    referred_by TEXT,

    created_at INTEGER NOT NULL

);

CREATE INDEX IF NOT EXISTS
idx_users_referred_by
ON users(referred_by);
`);


/* =========================================
   TELEGRAM AUTHENTICATION
========================================= */

function verifyTelegramInitData(initData) {

    if (!BOT_TOKEN || !initData) {
        return null;
    }

    const params =
        new URLSearchParams(initData);

    const hash =
        params.get("hash");

    const authDate =
        Number(params.get("auth_date"));

    if (!hash || !authDate) {
        return null;
    }

    const currentTime =
        Math.floor(Date.now() / 1000);

    /*
      Tolak initData yang lebih tua
      dari 24 jam.
    */

    if (
        currentTime - authDate >
        86400
    ) {
        return null;
    }

    params.delete("hash");

    const dataCheckString =
        [...params.entries()]
            .sort(
                ([a], [b]) =>
                    a.localeCompare(b)
            )
            .map(
                ([key, value]) =>
                    `${key}=${value}`
            )
            .join("\n");

    const secretKey =
        crypto
            .createHmac(
                "sha256",
                "WebAppData"
            )
            .update(BOT_TOKEN)
            .digest();

    const calculatedHash =
        crypto
            .createHmac(
                "sha256",
                secretKey
            )
            .update(dataCheckString)
            .digest("hex");

    if (
        calculatedHash.length !==
        hash.length
    ) {
        return null;
    }

    if (
        !crypto.timingSafeEqual(
            Buffer.from(calculatedHash),
            Buffer.from(hash)
        )
    ) {
        return null;
    }

    const userData =
        params.get("user");

    if (!userData) {
        return null;
    }

    try {

        return JSON.parse(userData);

    } catch {

        return null;

    }
}


/* =========================================
   AUTH MIDDLEWARE
========================================= */

function auth(req, res, next) {

    const initData =
        req.headers[
            "x-telegram-init-data"
        ] || "";

    const user =
        verifyTelegramInitData(
            initData
        );

    if (!user?.id) {

        return res
            .status(401)
            .json({
                error:
                    "Telegram authentication gagal."
            });

    }

    req.tgUser = user;

    next();
}


/* =========================================
   GET USER
========================================= */

function getUser(id) {

    return db
        .prepare(
            `
            SELECT *
            FROM users
            WHERE telegram_id = ?
            `
        )
        .get(
            String(id)
        );
}


/* =========================================
   MINING CALCULATION
========================================= */

function calculateMining(user) {

    const elapsed =
        Date.now() -
        user.mining_started_at;

    const minutes =
        Math.max(
            0,
            elapsed / 60000
        );

    return (
        minutes *
        MINING_PER_MINUTE
    );
}


/* =========================================
   CREATE USER
========================================= */

function ensureUser(
    telegramUser,
    referralCode
) {

    const telegramId =
        String(
            telegramUser.id
        );

    let user =
        getUser(
            telegramId
        );


    /*
      Kalau user sudah ada,
      update data Telegram-nya.
    */

    if (user) {

        db.prepare(
            `
            UPDATE users

            SET
                username = ?,
                first_name = ?

            WHERE telegram_id = ?
            `
        ).run(

            telegramUser.username ||
                "",

            telegramUser.first_name ||
                "",

            telegramId

        );

        return getUser(
            telegramId
        );
    }


    /*
      Referral
    */

    let referredBy = null;


    if (
        referralCode &&
        referralCode !== telegramId
    ) {

        const referrer =
            getUser(
                referralCode
            );

        if (referrer) {

            referredBy =
                referralCode;

        }

    }


    const createdAt =
        Date.now();


    /*
      Buat user baru
    */

    db.prepare(
        `
        INSERT INTO users (

            telegram_id,
            username,
            first_name,
            wallet,
            balance,
            mining_started_at,
            last_spin_at,
            referred_by,
            created_at

        )

        VALUES (
            ?,
            ?,
            ?,
            '',
            0,
            ?,
            0,
            ?,
            ?
        )
        `
    ).run(

        telegramId,

        telegramUser.username ||
            "",

        telegramUser.first_name ||
            "",

        createdAt,

        referredBy,

        createdAt

    );


    /*
      Bonus referral hanya diberikan
      satu kali saat user baru dibuat.
    */

    if (referredBy) {

        db.prepare(
            `
            UPDATE users

            SET balance =
                balance + ?

            WHERE telegram_id = ?
            `
        ).run(

            REFERRAL_REWARD,

            referredBy

        );

    }


    return getUser(
        telegramId
    );
}


/* =========================================
   PUBLIC STATE
========================================= */

function publicState(user) {

    const mining =
        calculateMining(user);


    const spinAvailable =
        !user.last_spin_at ||
        (
            Date.now() -
            user.last_spin_at
        ) >= 86400000;


    return {

        user: {

            id:
                user.telegram_id,

            username:
                user.username,

            firstName:
                user.first_name,

            wallet:
                user.wallet || ""

        },


        balance:
            Number(
                user.balance.toFixed(4)
            ),


        mining:
            Number(
                mining.toFixed(4)
            ),


        miningPerMinute:
            MINING_PER_MINUTE,


        dailySpinAvailable:
            spinAvailable,


        referralLink:
            `https://t.me/${BOT_USERNAME}?start=ref_${user.telegram_id}`

    };
}


/* =========================================
   SESSION
========================================= */

app.post(
    "/api/session",
    auth,
    (req, res) => {

        const startParam =
            String(
                req.body?.startParam ||
                ""
            );


        let referralCode = "";


        if (
            startParam.startsWith(
                "ref_"
            )
        ) {

            referralCode =
                startParam.substring(
                    4
                );

        }


        const user =
            ensureUser(
                req.tgUser,
                referralCode
            );


        res.json(
            publicState(user)
        );

    }
);


/* =========================================
