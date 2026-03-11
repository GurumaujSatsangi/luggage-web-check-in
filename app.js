import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import ejs from "ejs";
import session from "express-session";
import { fileURLToPath } from "url";
import path from "path";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

const app = express();
app.use(express.static("public"));
const upload = multer({ storage: multer.memoryStorage() });
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === "production" },
  }),
);
app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    (accessToken, refreshToken, profile, done) => done(null, profile),
  ),
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

const port = Number(process.env.PORT) || 5000;

const getSupervisorEmails = () =>
  (process.env.SUPERVISOR_EMAILS || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);

const getStudentByEmail = async (email) => {
  return supabase
    .from("students")
    .select("id, name, email_id, registration_number, current_block, current_room_number, allotted_block, allotted_room_number, dormitory")
    .eq("email_id", email)
    .maybeSingle();
};

const isMissingColumnError = (error, columnName) => {
  const errorText = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return errorText.includes(columnName.toLowerCase());
};

const selectCheckinsByUser = async (email) => {
  const modernResult = await supabase
    .from("checkin")
    .select("*")
    .eq("user_email", email);

  if (!modernResult.error || !isMissingColumnError(modernResult.error, "user_email")) {
    return modernResult;
  }

  return supabase.from("checkin").select("*").eq("email", email);
};

const selectCheckinByIdForUser = async (id, email) => {
  const modernResult = await supabase
    .from("checkin")
    .select("*")
    .eq("id", id)
    .eq("user_email", email)
    .single();

  if (!modernResult.error || !isMissingColumnError(modernResult.error, "user_email")) {
    return modernResult;
  }

  return supabase
    .from("checkin")
    .select("*")
    .eq("id", id)
    .eq("email", email)
    .single();
};

const updateCheckinByIdForUser = async (id, email, values) => {
  const modernResult = await supabase
    .from("checkin")
    .update(values)
    .eq("id", id)
    .eq("user_email", email);

  if (!modernResult.error || !isMissingColumnError(modernResult.error, "user_email")) {
    return modernResult;
  }

  return supabase.from("checkin").update(values).eq("id", id).eq("email", email);
};

const deleteCheckinByIdForUser = async (id, email) => {
  const modernResult = await supabase
    .from("checkin")
    .delete()
    .eq("id", id)
    .eq("user_email", email);

  if (!modernResult.error || !isMissingColumnError(modernResult.error, "user_email")) {
    return modernResult;
  }

  return supabase.from("checkin").delete().eq("id", id).eq("email", email);
};

const insertCheckinForUser = async ({ scheduled_check_in_date, scheduled_check_in_time, luggage_info, user }) => {
  const baseValues = {
    scheduled_check_in_date,
    scheduled_check_in_time,
    luggage_info,
  };

  const withUserEmailAndName = await supabase.from("checkin").insert({
    ...baseValues,
    user_email: user.email,
    user_name: user.name,
  });

  if (!withUserEmailAndName.error) {
    return withUserEmailAndName;
  }

  if (!isMissingColumnError(withUserEmailAndName.error, "user_name")) {
    if (!isMissingColumnError(withUserEmailAndName.error, "user_email")) {
      return withUserEmailAndName;
    }
  }

  const withUserEmailOnly = await supabase.from("checkin").insert({
    ...baseValues,
    user_email: user.email,
  });

  if (!withUserEmailOnly.error || !isMissingColumnError(withUserEmailOnly.error, "user_email")) {
    return withUserEmailOnly;
  }

  return supabase.from("checkin").insert({
    ...baseValues,
    email: user.email,
  });
};

// ── Auth middleware ──────────────────────────────────────────────────────────

const requireAuth = async (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect("/");
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    const { data: student, error } = await getStudentByEmail(req.user.email);
    if (error || !student) {
      res.clearCookie("token");
      return res.redirect(
        "/?message=Your Google email is not registered in the students table. Contact the hostel office.",
      );
    }
    req.user.student = student;
    next();
  } catch {
    res.clearCookie("token");
    return res.redirect("/");
  }
};

const requireSupervisor = async (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect("/");
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    const { data: student, error } = await getStudentByEmail(req.user.email);
    if (error || !student) {
      res.clearCookie("token");
      return res.redirect(
        "/?message=Your Google email is not registered in the students table. Contact the hostel office.",
      );
    }
    req.user.student = student;
    const supervisorEmails = getSupervisorEmails();
    if (!supervisorEmails.includes(req.user.email)) {
      return res.status(403).send("Access denied: Supervisors only.");
    }
    next();
  } catch {
    res.clearCookie("token");
    return res.redirect("/");
  }
};

// ── OAuth routes ─────────────────────────────────────────────────────────────

app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"],   hd: "vitstudent.ac.in"
}),
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  async (req, res) => {
    const profile = req.user;
    const userEmail = profile.emails?.[0]?.value;
    const userPicture = profile.photos?.[0]?.value || "";

    if (!userEmail) {
      return res.redirect("/?message=Google account email is required for login.");
    }

    const { data: student, error: studentError } = await getStudentByEmail(userEmail);

    if (studentError) {
      return res.redirect(
        `/?message=${encodeURIComponent(studentError.message || "Unable to verify student account.")}`,
      );
    }

    if (!student) {
      return res.redirect(
        "/?message=Your Google email is not registered in the students table. Contact the hostel office.",
      );
    }

    const token = jwt.sign(
      {
        id: profile.id,
        name: student.name || profile.displayName,
        email: userEmail,
        picture: userPicture,
        registrationNumber: student.registration_number,
        dormitory: student.dormitory,
        studentId: student.id,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const supervisorEmails = getSupervisorEmails();
    if (supervisorEmails.includes(userEmail)) {
      return res.redirect("/supervisor/dashboard");
    }
    return res.redirect("/dashboard");
  },
);

app.get("/logout", (req, res) => {
  res.clearCookie("token");
  req.logout(() => res.redirect("/"));
});

// ── Public routes ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  const token = req.cookies.token;
  const message = req.query.message || null;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const supervisorEmails = getSupervisorEmails();
      if (supervisorEmails.includes(decoded.email)) {
        return res.redirect("/supervisor/dashboard");
      }
      return res.redirect("/dashboard");
    } catch {
      res.clearCookie("token");
    }
  }
  return res.render("home.ejs", { message });
});

// ── Protected routes ──────────────────────────────────────────────────────────

app.get("/dashboard", requireAuth, async (req, res) => {
  const message = req.query;
  const { data, error } = await selectCheckinsByUser(req.user.email);

  return res.render("dashboard.ejs", {
    data: data || [],
    message: message || null,
    user: req.user,
  });
});

app.post("/confirm/modify/:id", requireAuth, async (req, res) => {
  const { scheduled_check_in_date, scheduled_check_in_time, luggage_info } =
    req.body;
  await updateCheckinByIdForUser(req.params.id, req.user.email, {
    scheduled_check_in_date,
    scheduled_check_in_time,
    luggage_info,
  });
  return res.redirect("/dashboard?message=Scheduled Check-In Updated Successfully!");
});

const today = new Date();
const isoDate = today.toLocaleDateString("en-CA", {
  timeZone: "Asia/Kolkata",
});

app.get("/supervisor/dashboard", requireSupervisor, async (req, res) => {
  const { data, error } = await supabase
    .from("checkin")
    .select("*")
    .neq("status", "LUGGAGE CHECKED-IN")
    .eq("scheduled_check_in_date", isoDate);
  return res.render("supervisor.ejs", { data, user: req.user });
});

app.get("/modify/:id", requireAuth, async (req, res) => {
  const { data, error } = await selectCheckinByIdForUser(req.params.id, req.user.email);
  res.render("edit.ejs", { data, user: req.user });
});

app.get("/delete/:id", requireAuth, async (req, res) => {
  await deleteCheckinByIdForUser(req.params.id, req.user.email);
  return res.redirect("/dashboard?message=Check-In Schedule deleted successfully!");
});

app.get("/check-in/:id", requireSupervisor, async (req, res) => {
  await supabase
    .from("checkin")
    .update({ status: "LUGGAGE CHECKED-IN" })
    .eq("id", req.params.id);
  return res.redirect("/supervisor/dashboard?message=Luggage Checked-In!");
});

app.post("/schedule-check-in", requireAuth, async (req, res) => {
  const { scheduled_check_in_date, scheduled_check_in_time, luggage_info } =
    req.body;

  if (scheduled_check_in_date < isoDate) {
    return res.redirect(
      "/dashboard?message=Luggage Check-In cannot be scheduled for past dates. Luggage Check-In for the next day will close today at 11:59 PM.",
    );
  }

  if (scheduled_check_in_date == isoDate) {
    return res.redirect(
      "/dashboard?message=Luggage Check-In cannot be scheduled for the same day. Luggage Check-In for the next day will close today at 11:59 PM.",
    );
  }

  const { error } = await insertCheckinForUser({
    scheduled_check_in_date,
    scheduled_check_in_time,
    luggage_info,
    user: req.user,
  });

  if (error) {
    return res.redirect(
      `/dashboard?message=${encodeURIComponent(error.message || "Some error occurred, please try again!")}`,
    );
  }

  return res.redirect("/dashboard?message=Check-In Scheduled Successfully!");
});

app.listen(port);
