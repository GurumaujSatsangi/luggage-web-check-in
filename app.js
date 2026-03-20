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

// const selectSupervisorCheckinsByDormitory = async ({ scheduledDate, dormitory }) => {
//   return supabase
//     .from("checkin")
//     .select("*")
//     .eq("scheduled_check_in_date", scheduledDate)
//     .eq("dormitory", dormitory)
//     .neq("status", "LUGGAGE CHECKED-IN");
// };

const insertCheckinForUser = async ({ scheduled_check_in_date, scheduled_check_in_time, luggage_info, user, image }) => {
  const buildBaseValues = (includeImage) => ({
    scheduled_check_in_date,
    scheduled_check_in_time,
    luggage_info,
    ...(includeImage ? { image } : {}),
  });

  const includeImage = Boolean(image);
  let baseValues = buildBaseValues(includeImage);

  let withUserEmailAndName = await supabase.from("checkin").insert({
    ...baseValues,
    user_email: user.email,
    user_name: user.name,
  });

  if (includeImage && isMissingColumnError(withUserEmailAndName.error, "image")) {
    baseValues = buildBaseValues(false);
    withUserEmailAndName = await supabase.from("checkin").insert({
      ...baseValues,
      user_email: user.email,
      user_name: user.name,
    });
  }

  if (!withUserEmailAndName.error) {
    return withUserEmailAndName;
  }

  if (!isMissingColumnError(withUserEmailAndName.error, "user_name")) {
    if (!isMissingColumnError(withUserEmailAndName.error, "user_email")) {
      return withUserEmailAndName;
    }
  }

  let withUserEmailOnly = await supabase.from("checkin").insert({
    ...baseValues,
    user_email: user.email,
  });

  if (includeImage && isMissingColumnError(withUserEmailOnly.error, "image")) {
    baseValues = buildBaseValues(false);
    withUserEmailOnly = await supabase.from("checkin").insert({
      ...baseValues,
      user_email: user.email,
    });
  }

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

app.get("/supervisor/dashboard", requireSupervisorAuth, async (req, res) => {
  const todayIsoDate = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
  const supervisorDormitory = (req.user.assignedDormitory || req.user.assigned_dormitory || "").trim();

  const { data, error } = await supabase
    .from("checkin")
    .select("*")
    .eq("scheduled_check_in_date", todayIsoDate)
    .neq("status", "LUGGAGE CHECKED-IN")
    .eq("dormitory", supervisorDormitory);

  if (error) {
    return res.redirect(
      `/supervisor/login?message=${encodeURIComponent(error.message || "Unable to fetch supervisor dashboard data.")}`,
    );
  }

  const checkins = data || [];
  const emails = [...new Set(checkins.map((item) => item.email).filter(Boolean))];

  let studentByEmail = new Map();
  if (emails.length > 0) {
    const { data: students, error: studentError } = await supabase
      .from("students")
      .select("email_id, name, registration_number")
      .in("email_id", emails);

    if (studentError) {
      return res.redirect(
        `/supervisor/login?message=${encodeURIComponent(studentError.message || "Unable to fetch student details.")}`,
      );
    }

    studentByEmail = new Map((students || []).map((student) => [student.email_id, student]));
  }

  const enrichedCheckins = checkins.map((item) => {
    const student = studentByEmail.get(item.email);
    return {
      ...item,
      student_name: student?.name || "N/A",
      registration_number: student?.registration_number || "N/A",
    };
  });

  return res.render("supervisor.ejs", { data: enrichedCheckins, user: req.user });
});

app.get("/modify/:id", requireAuth, async (req, res) => {
  const { data, error } = await selectCheckinByIdForUser(req.params.id, req.user.email);

  const scheduled_check_in_date = data.scheduled_check_in_date;

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
  await deleteCheckinByIdForUser(req.params.id, req.user.email);
  return res.redirect("/dashboard?message=Check-In Schedule deleted successfully!");
});

app.get("/check-in/:id", requireSupervisorAuth, async (req, res) => {
  await supabase
    .from("checkin")
    .update({ status: "LUGGAGE CHECKED-IN" })
    .eq("id", req.params.id);
  return res.redirect("/supervisor/dashboard?message=Luggage Checked-In!");
});

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

app.post("/schedule-check-in", upload.single('image'), requireAuth, async (req, res) => {
  const { scheduled_check_in_date, scheduled_check_in_time, luggage_info} =
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



  const { error } = await insertCheckinForUser({
    scheduled_check_in_date,
    scheduled_check_in_time,
    luggage_info,
    user: req.user,
    image: publicUrl,
  });

  if (error) {
    return res.redirect(
      `/dashboard?message=${encodeURIComponent(error.message || "Some error occurred, please try again!")}`,
    );
  }

  return res.redirect("/dashboard?message=Check-In Scheduled Successfully!");
});

app.listen(port);