import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_USERNAME =
  process.env.BOT_USERNAME || "JaslinGameBot";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "";

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY || "";

const MINING_PER_MINUTE =
  Number(process.env.MINING_PER_MINUTE || 0.045);

const DAILY_SPIN_REWARD =
  Number(process.env.DAILY_SPIN_REWARD || 25);

const REFERRAL_REWARD =
  Number(process.env.REFERRAL_REWARD || 10);


/* =========================================
   SUPABASE
========================================= */

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);


app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/* =========================================
   TELEGRAM AUTH
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

  const now =
    Math.floor(Date.now() / 1000);

  if (
    now - authDate >
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

  try {

    const valid =
      crypto.timingSafeEqual(
        Buffer.from(
          calculatedHash,
          "hex"
        ),
        Buffer.from(
          hash,
          "hex"
        )
      );

    if (!valid) {
      return null;
    }

  } catch {
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
   TABEL: users
========================================= */

async function getUser(id) {

  const {
    data,
    error
  } =
    await supabase
      .from("users")
      .select("*")
      .eq(
        "telegram_id",
        String(id)
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}


/* =========================================
   TRANSACTION LOG
   TABEL: transactions
========================================= */

async function saveTransaction(
  telegramId,
  type,
  amount,
  note = "",
  txSignature = null,
  status = "completed"
) {

  const {
    error
  } =
    await supabase
      .from("transactions")
      .insert({

        telegram_id:
          String(telegramId),

        type:
          type,

        amount:
          Number(amount),

        status:
          status,

        tx_signature:
          txSignature,

        note:
          note,

        created_at:
          Date.now()

      });

  if (error) {

    console.error(
      "Transaction error:",
      error.message
    );

  }
}


/* =========================================
   MINING CALCULATION
========================================= */

function calculateMining(user) {

  const started =
    Number(
      user.mining_started_at
    );

  const elapsed =
    Date.now() -
    started;

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
   CREATE / UPDATE USER
========================================= */

async function ensureUser(
  telegramUser,
  referralCode
) {

  const telegramId =
    String(
      telegramUser.id
    );

  let user =
    await getUser(
      telegramId
    );


  /* USER SUDAH ADA */

  if (user) {

    const {
      error
    } =
      await supabase
        .from("users")
        .update({

          username:
            telegramUser.username || "",

          first_name:
            telegramUser.first_name || ""

        })
        .eq(
          "telegram_id",
          telegramId
        );

    if (error) {
      throw error;
    }

    return await getUser(
      telegramId
    );
  }


  /* REFERRAL */

  let referredBy = null;

  if (
    referralCode &&
    referralCode !== telegramId
  ) {

    const referrer =
      await getUser(
        referralCode
      );

    if (referrer) {

      referredBy =
        referralCode;

    }

  }


  const createdAt =
    Date.now();


  /* BUAT USER */

  const {
    error
  } =
    await supabase
      .from("users")
      .insert({

        telegram_id:
          telegramId,

        username:
          telegramUser.username || "",

        first_name:
          telegramUser.first_name || "",

        wallet:
          "",

        balance:
          0,

        mining_started_at:
          createdAt,

        last_spin_at:
          0,

        referred_by:
          referredBy,

        created_at:
          createdAt

      });

  if (error) {
    throw error;
  }


  /* BONUS REFERRAL */

  if (referredBy) {

    const referrer =
      await getUser(
        referredBy
      );

    if (referrer) {

      const newBalance =
        Number(
          referrer.balance
        ) +
        REFERRAL_REWARD;

      const {
        error:
          referralError
      } =
        await supabase
          .from("users")
          .update({

            balance:
              newBalance

          })
          .eq(
            "telegram_id",
            referredBy
          );

      if (referralError) {
        throw referralError;
      }

      await saveTransaction(

        referredBy,

        "referral",

        REFERRAL_REWARD,

        `Referral dari ${telegramId}`

      );

    }

  }

  return await getUser(
    telegramId
  );
}


/* =========================================
   PUBLIC STATE
========================================= */

function publicState(user) {

  const mining =
    calculateMining(user);

  const lastSpin =
    Number(
      user.last_spin_at
    );

  const spinAvailable =
    !lastSpin ||
    (
      Date.now() -
      lastSpin
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
        Number(
          user.balance
        ).toFixed(4)
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
      `https://t.me/${BOT_USERNAME}?startapp=ref_${user.telegram_id}`

  };
}


/* =========================================
   SESSION
========================================= */

app.post(
  "/api/session",
  auth,
  async (req, res) => {

    try {

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
        await ensureUser(
          req.tgUser,
          referralCode
        );

      res.json(
        publicState(user)
      );

    } catch (error) {

      console.error(error);

      res
        .status(500)
        .json({
          error:
            "Gagal membuat session."
        });

    }

  }
);


/* =========================================
   STATE
========================================= */

app.get(
  "/api/state",
  auth,
  async (req, res) => {

    try {

      const user =
        await getUser(
          req.tgUser.id
        );

      if (!user) {

        return res
          .status(404)
          .json({
            error:
              "User belum terdaftar."
          });

      }

      res.json(
        publicState(user)
      );

    } catch (error) {

      console.error(error);

      res
        .status(500)
        .json({
          error:
            "Gagal mengambil data."
        });

    }

  }
);


/* =========================================
   CLAIM MINING
========================================= */

app.post(
  "/api/claim",
  auth,
  async (req, res) => {

    try {

      const user =
        await getUser(
          req.tgUser.id
        );

      if (!user) {

        return res
          .status(404)
          .json({
            error:
              "User tidak ditemukan."
          });

      }

      const claimed =
        Number(
          calculateMining(user)
            .toFixed(8)
        );

      if (claimed <= 0) {

        return res
          .status(400)
          .json({
            error:
              "Belum ada mining."
          });

      }

      const newBalance =
        Number(
          user.balance
        ) +
        claimed;

      const now =
        Date.now();

      const {
        error
      } =
        await supabase
          .from("users")
          .update({

            balance:
              newBalance,

            mining_started_at:
              now

          })
          .eq(
            "telegram_id",
            String(
              req.tgUser.id
            )
          );

      if (error) {
        throw error;
      }

      await saveTransaction(

        req.tgUser.id,

        "mining",

        claimed,

        "Mining claim"

      );

      const updated =
        await getUser(
          req.tgUser.id
        );

      res.json({

        ...publicState(updated),

        claimed:
          Number(
            claimed.toFixed(4)
          )

      });

    } catch (error) {

      console.error(error);

      res
        .status(500)
        .json({
          error:
            "Claim mining gagal."
        });

    }

  }
);


/* =========================================
   DAILY SPIN
========================================= */

app.post(
  "/api/spin",
  auth,
  async (req, res) => {

    try {

      const user =
        await getUser(
          req.tgUser.id
        );

      if (!user) {

        return res
          .status(404)
          .json({
            error:
              "User tidak ditemukan."
          });

      }

      const lastSpin =
        Number(
          user.last_spin_at
        );

      if (
        lastSpin &&
        Date.now() -
        lastSpin <
        86400000
      ) {

        return res
          .status(400)
          .json({
            error:
              "Daily Spin sudah digunakan."
          });

      }

      const reward =
        DAILY_SPIN_REWARD;

      const newBalance =
        Number(
          user.balance
        ) +
        reward;

      const now =
        Date.now();

      const {
        error
      } =
        await supabase
          .from("users")
          .update({

            balance:
              newBalance,

            last_spin_at:
              now

          })
          .eq(
            "telegram_id",
            String(
              req.tgUser.id
            )
          );

      if (error) {
        throw error;
      }

      await saveTransaction(

        req.tgUser.id,

        "daily_spin",

        reward,

        "Daily Spin"

      );

      const updated =
        await getUser(
          req.tgUser.id
        );

      res.json({

        ...publicState(updated),

        reward:
          reward

      });

    } catch (error) {

      console.error(error);

      res
        .status(500)
        .json({
          error:
            "Daily Spin gagal."
        });

    }

  }
);


/* =========================================
   WALLET
========================================= */

app.post(
  "/api/wallet",
  auth,
  async (req, res) => {

    try {

      const wallet =
        String(
          req.body?.wallet ||
          ""
        ).trim();

      if (
        wallet &&
        (
          wallet.length < 32 ||
          wallet.length > 44
        )
      ) {

        return res
          .status(400)
          .json({
            error:
              "Alamat wallet Solana tidak valid."
          });

      }

      const {
        error
      } =
        await supabase
          .from("users")
          .update({

            wallet:
              wallet

          })
          .eq(
            "telegram_id",
            String(
              req.tgUser.id
            )
          );

      if (error) {
        throw error;
      }

      res.json({
        wallet:
          wallet
      });

    } catch (error) {

      console.error(error);

      res
        .status(500)
        .json({
          error:
            "Gagal menyimpan wallet."
        });

    }

  }
);


/* =========================================
   HEALTH CHECK
========================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      status:
        "ok",

      game:
        "JASLIN",

      database:
        "Supabase"

    });

  }
);


/* =========================================
   START
========================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `JASLIN server running on port ${PORT}`
    );

  }
);
