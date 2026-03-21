import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import AWS from 'aws-sdk'
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
import bcrypt from "bcrypt";

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
const supervisorTokenCookie = "supervisor_token";

const getSupervisorByEmployeeId = async (employeeId) => {
  return supabase
    .from("supervisors")
    .select("emp_id, name, assigned_dormitory, password")
    .eq("emp_id", employeeId)
    .maybeSingle();
};

const createSupervisorToken = (supervisor) => {
  return jwt.sign(
    {
      name: supervisor.name || `Supervisor ${supervisor.emp_id}`,
      employeeId: supervisor.emp_id,
      assignedDormitory: supervisor.assigned_dormitory,
      role: "supervisor",
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
};

const parseSupervisorToken = (token) => {
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "supervisor") return null;
    return decoded;
  } catch {
    return null;
  }
};

const getStudentByEmail = async (email) => {
  return supabase
    .from("students")
    .select("id, name, email_id, registration_number, current_block, current_room_number, allotted_block, allotted_room_number, dormitory")
    .eq("email_id", email)
    .maybeSingle();
};

const getStudentEmailsByDormitory = async (dormitory) => {
  return supabase
    .from("students")
    .select("email_id")
    .eq("dormitory", dormitory);
};

const isMissingColumnError = (error, columnName) => {
  const errorText = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return errorText.includes(columnName.toLowerCase());
};

// ── Auth middleware ──────────────────────────────────────────────────────────

const requireAuth = async (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect("/");
  try {
    const decodedUser = jwt.verify(token, process.env.JWT_SECRET);
    const { data: student, error } = await getStudentByEmail(decodedUser.email);
    if (error || !student) {
      res.clearCookie("token");
      return res.redirect(
        "/?message=Your VIT Email ID is not registered in the students database. Kindly contact the Hostel Administrative Office (cw.mh@vit.ac.in / cw.lh@vit.ac.in / director.mh@vit.ac.in / director.lh@vit.ac.in).",
      );
    }
    req.user = {
      ...decodedUser,
      student,
      name: student.name || decodedUser.name,
      email: student.email_id || decodedUser.email,
      registrationNumber: student.registration_number,
      current_block: student.current_block,
      current_room_number: student.current_room_number,
      allotted_block: student.allotted_block,
      allotted_room_number: student.allotted_room_number,
      dormitory: student.dormitory,
    };
    next();
  } catch {
    res.clearCookie("token");
    return res.redirect("/");
  }
};

const requireSupervisorAuth = (req, res, next) => {
  const decodedSupervisor = parseSupervisorToken(req.cookies[supervisorTokenCookie]);
  if (!decodedSupervisor) {
    res.clearCookie(supervisorTokenCookie);
    return res.redirect("/supervisor/login?message=Please login to continue.");
  }

  req.user = decodedSupervisor;
  return next();
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
    return res.redirect("/dashboard");
  },
);

app.get("/logout", (req, res) => {
  res.clearCookie("token");
  res.clearCookie(supervisorTokenCookie);
  req.session.supervisor = null;
  req.logout(() => res.redirect("/"));
});

// ── Public routes ─────────────────────────────────────────────────────────────

const getIndiaDateTime = () => {
  const now = new Date();
  return {
    isoDate: now.toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    }),
    time: now.toLocaleTimeString("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  };
};

const normalizeDormitory = (value) => (value || "").trim().toLowerCase();


app.get("/", (req, res) => {
  const token = req.cookies.token;
  const message = req.query.message || null;
  const supervisor = parseSupervisorToken(req.cookies[supervisorTokenCookie]);

  if (supervisor) {
    return res.redirect("/supervisor/dashboard");
  }

  if (req.cookies[supervisorTokenCookie]) {
    res.clearCookie(supervisorTokenCookie);
  }

  if (token) {
    try {
      jwt.verify(token, process.env.JWT_SECRET);
      return res.redirect("/dashboard");
    } catch {
      res.clearCookie("token");
    }
  }
  return res.render("home.ejs", { message });
});

app.get("/supervisor/login", (req, res) => {
  const message = req.query.message || null;
  const supervisor = parseSupervisorToken(req.cookies[supervisorTokenCookie]);

  if (supervisor) {
    return res.redirect("/supervisor/dashboard");
  }

  if (req.cookies[supervisorTokenCookie]) {
    res.clearCookie(supervisorTokenCookie);
  }

  return res.render("supervisor-login.ejs", { message });
});

app.post("/supervisor/login", async (req, res) => {
  const employeeId = (req.body.employee_id || "").trim();
  const password = (req.body.password || "").trim();

  if (!employeeId || !password) {
    return res.redirect("/supervisor/login?message=Employee ID and password are required.");
  }

  const { data: supervisor, error } = await getSupervisorByEmployeeId(employeeId);

  if (error) {
    return res.redirect(
      `/supervisor/login?message=${encodeURIComponent(error.message || "Unable to verify supervisor account.")}`,
    );
  }

  if (!supervisor) {
    return res.redirect("/supervisor/login?message=Invalid employee ID or password.");
  }

  const passwordMatches = await bcrypt.compare(password, supervisor.password || "");
  if (!passwordMatches) {
    return res.redirect("/supervisor/login?message=Invalid employee ID or password.");
  }

  const supervisorToken = createSupervisorToken(supervisor);
  res.cookie(supervisorTokenCookie, supervisorToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.redirect("/supervisor/dashboard?message=Login successful.");
});

// ── Protected routes ──────────────────────────────────────────────────────────

app.get("/dashboard", requireAuth, async (req, res) => {
  const message = req.query;
  let { data, error } = await supabase
    .from("checkin")
    .select("*")
    .eq("user_email", req.user.email);

  if (error && isMissingColumnError(error, "user_email")) {
    const legacyResult = await supabase
      .from("checkin")
      .select("*")
      .eq("email", req.user.email);
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) {
    return res.redirect(
      `/dashboard?message=${encodeURIComponent(error.message || "Unable to fetch check-ins.")}`,
    );
  }

  return res.render("dashboard.ejs", {
    data: data || [],
    message: message || null,
    user: req.user,
  });
});

app.post("/confirm/modify/:id", requireAuth, async (req, res) => {
  const { scheduled_check_in_date, scheduled_check_in_time, luggage_info } =
    req.body;
  const values = {
    scheduled_check_in_date,
    scheduled_check_in_time,
    luggage_info,
  };

  let { error } = await supabase
    .from("checkin")
    .update(values)
    .eq("id", req.params.id)
    .eq("user_email", req.user.email);

  if (error && isMissingColumnError(error, "user_email")) {
    const legacyResult = await supabase
      .from("checkin")
      .update(values)
      .eq("id", req.params.id)
      .eq("email", req.user.email);
    error = legacyResult.error;
  }

  if (error) {
    return res.redirect(
      `/dashboard?message=${encodeURIComponent(error.message || "Unable to update check-in.")}`,
    );
  }

  return res.redirect("/dashboard?message=Scheduled Check-In Updated Successfully!");
});



app.get("/supervisor/dashboard", requireSupervisorAuth, async (req, res) => {
  const { isoDate: todayIsoDate } = getIndiaDateTime();
  const supervisorDormitory = req.user.assignedDormitory || req.user.assigned_dormitory || "";
  const normalizedSupervisorDormitory = normalizeDormitory(supervisorDormitory);

  const { data: checkinCandidates, error } = await supabase
    .from("checkin")
    .select("*")
    .eq("scheduled_check_in_date", todayIsoDate);

  const { data: checkoutCandidates, error: checkoutError } = await supabase
    .from("checkin")
    .select("*")
    .eq("status", "LUGGAGE CHECKED-IN");

  if (error) {
    return res.redirect(
      `/supervisor/login?message=${encodeURIComponent(error.message || "Unable to fetch supervisor dashboard data.")}`,
    );
  }

  if (checkoutError) {
    return res.redirect(
      `/supervisor/login?message=${encodeURIComponent(checkoutError.message || "Unable to fetch checkout data.")}`,
    );
  }

  const checkins = (checkinCandidates || []).filter((item) => {
    const status = (item.status || "").trim().toUpperCase();
    const isPendingCheckin = status !== "LUGGAGE CHECKED-IN" && status !== "LUGGAGE CHECKED-OUT";
    return (
      isPendingCheckin
      && normalizeDormitory(item.dormitory) === normalizedSupervisorDormitory
    );
  });
  const checkouts = (checkoutCandidates || []).filter(
    (item) => normalizeDormitory(item.dormitory) === normalizedSupervisorDormitory,
  );
  const allEmails = [
    ...new Set(
      [...checkins, ...checkouts]
        .map((item) => item.user_email || item.email)
        .filter(Boolean),
    ),
  ];

  let studentByEmail = new Map();
  if (allEmails.length > 0) {
    const { data: students, error: studentError } = await supabase
      .from("students")
      .select("email_id, name, registration_number")
      .in("email_id", allEmails);

    if (studentError) {
      return res.redirect(
        `/supervisor/login?message=${encodeURIComponent(studentError.message || "Unable to fetch student details.")}`,
      );
    }

    studentByEmail = new Map((students || []).map((student) => [student.email_id, student]));
  }

  const enrichedCheckins = checkins.map((item) => {
    const student = studentByEmail.get(item.user_email || item.email);
    return {
      ...item,
      student_name: student?.name || "N/A",
      registration_number: student?.registration_number || "N/A",
    };
  });

  const enrichedCheckouts = checkouts.map((item) => {
    const student = studentByEmail.get(item.user_email || item.email);
    return {
      ...item,
      student_name: student?.name || "N/A",
      registration_number: student?.registration_number || "N/A",
    };
  });

  return res.render("supervisor.ejs", { data: enrichedCheckins, enrichedCheckouts, user: req.user });
});

app.get("/modify/:id", requireAuth, async (req, res) => {
  let { data, error } = await supabase
    .from("checkin")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_email", req.user.email)
    .single();

  if (error && isMissingColumnError(error, "user_email")) {
    const legacyResult = await supabase
      .from("checkin")
      .select("*")
      .eq("id", req.params.id)
      .eq("email", req.user.email)
      .single();
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error || !data) {
    return res.redirect(
      `/dashboard?message=${encodeURIComponent(error?.message || "Unable to fetch check-in details.")}`,
    );
  }

  const scheduled_check_in_date = data.scheduled_check_in_date;
  const { isoDate } = getIndiaDateTime();

   if (scheduled_check_in_date < isoDate) {
    return res.redirect(
              "/dashboard?message=Scheduled Check-In for a previous date cannot be modified at this time. Luggage Check-In for the next day will close today at 11:59 PM.",

    );
  }



  if (scheduled_check_in_date == isoDate) {
    return res.redirect(
      "/dashboard?message=Scheduled Check-In cannot be modified on the day of the scheduled Check-In. Luggage Check-In for the next day will close today at 11:59 PM.",
    );
  }

  res.render("edit.ejs", { data, user: req.user });
});

app.get("/delete/:id", requireAuth, async (req, res) => {
  let { error } = await supabase
    .from("checkin")
    .delete()
    .eq("id", req.params.id)
    .eq("user_email", req.user.email);

  if (error && isMissingColumnError(error, "user_email")) {
    const legacyResult = await supabase
      .from("checkin")
      .delete()
      .eq("id", req.params.id)
      .eq("email", req.user.email);
    error = legacyResult.error;
  }

  if (error) {
    return res.redirect(
      `/dashboard?message=${encodeURIComponent(error.message || "Unable to delete check-in.")}`,
    );
  }

  return res.redirect("/dashboard?message=Check-In Schedule deleted successfully!");
});

app.get("/check-in/:id", requireSupervisorAuth, async (req, res) => {
  const { isoDate: todayIsoDate, time: currentTime } = getIndiaDateTime();

  await supabase
    .from("checkin")
    .update({ status: "LUGGAGE CHECKED-IN",check_in_date:todayIsoDate,check_in_time:currentTime,received_by:req.user.name })
    .eq("id", req.params.id);
  return res.redirect("/supervisor/dashboard?message=Luggage Checked-In!");
});


app.get("/check-out/:id", requireSupervisorAuth, async (req, res) => {
  const { isoDate: todayIsoDate, time: currentTime } = getIndiaDateTime();

  await supabase
    .from("checkin")
    .update({ status: "LUGGAGE CHECKED-OUT",check_out_date:todayIsoDate,check_out_time:currentTime,release_by:req.user.name })
    .eq("id", req.params.id);
  return res.redirect("/supervisor/dashboard?message=Luggage Checked-Out!");
});

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

app.post("/schedule-check-in", upload.single('image'), requireAuth, async (req, res) => {
  const { scheduled_check_in_date, scheduled_check_in_time, luggage_info} =
    req.body;
  const { isoDate } = getIndiaDateTime();

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


  const image = req.file;

  let publicUrl = null;

  if (image) {
    const key = `${Date.now()}-${image.originalname.replace(/\s+/g, "-")}`;
    const params = {
      Bucket: process.env.AWS_S3_BUCKET_NAME,
      Key: key,
      Body: image.buffer,
      ContentType: image.mimetype,
      ACL:'public-read'
    };

    try {
      const result = await s3.upload(params).promise();
      publicUrl = result.Location;
      console.log(publicUrl);
    } catch (uploadError) {
      console.error(uploadError);
      return res.redirect(
        "/dashboard?message=Image upload failed. Please try again.",
      );
    }
  }

  const buildBaseValues = (includeImage) => ({
    scheduled_check_in_date,
    scheduled_check_in_time,
    luggage_info,
    dormitory: req.user.dormitory,
    ...(includeImage ? { image: publicUrl } : {}),
  });

  const includeImage = Boolean(publicUrl);
  let baseValues = buildBaseValues(includeImage);

  let insertResult = await supabase.from("checkin").insert({
    ...baseValues,
    user_email: req.user.email,
    user_name: req.user.name,
  });

  if (includeImage && isMissingColumnError(insertResult.error, "image")) {
    baseValues = buildBaseValues(false);
    insertResult = await supabase.from("checkin").insert({
      ...baseValues,
      user_email: req.user.email,
      user_name: req.user.name,
    });
  }

  if (insertResult.error && isMissingColumnError(insertResult.error, "user_name")) {
    insertResult = await supabase.from("checkin").insert({
      ...baseValues,
      user_email: req.user.email,
    });

    if (includeImage && isMissingColumnError(insertResult.error, "image")) {
      baseValues = buildBaseValues(false);
      insertResult = await supabase.from("checkin").insert({
        ...baseValues,
        user_email: req.user.email,
      });
    }
  }

  if (insertResult.error && isMissingColumnError(insertResult.error, "user_email")) {
    insertResult = await supabase.from("checkin").insert({
      ...baseValues,
      email: req.user.email,
    });
  }

  const error = insertResult.error;

  if (error) {
    return res.redirect(
      `/dashboard?message=${encodeURIComponent(error.message || "Some error occurred, please try again!")}`,
    );
  }

  return res.redirect("/dashboard?message=Check-In Scheduled Successfully!");
});

app.listen(port);