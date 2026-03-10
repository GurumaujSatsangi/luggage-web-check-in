import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import ejs from "ejs";
import session from "express-session";
import { fileURLToPath } from "url";
import path from "path";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

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
app.use(express.static("public"));

const port = Number(process.env.PORT) || 5000;

app.get("/", async (req, res) => {
  return res.render("home.ejs");
});

app.get("/dashboard", async (req, res) => {
  const message = req.query;
  const { data, error } = await supabase.from("checkin").select("*");

  return res.render("dashboard.ejs", { data: data, message: message || null });
});


app.put("/edit/:id", async(req,res)=>{

    const {scheduled_check_in_date, scheduled_check_in_time, luggae_info, image} = req.body;
    const {data,error} = await supabase.from("checkin").update({scheduled_check_in_date:scheduled_check_in_date,scheduled_check_in_time:scheduled_check_in_time,luggage_info:luggae_info,image:image}).eq("id",req.params.id);
    return res.redirect("/dashboard?message=Scheduled Check-In Updated Succesfully!");
})

app.post("/schedule-check-in", async (req, res) => {
  const {
    check_in_date,
    check_out_date,
    check_in_time,
    check_out_time,
    luggage_info,
    image,
  } = req.body;

  const { data, error } = await supabase
    .from("checkin")
    .insert({
      scheduled_check_in_date: check_in_date,
      scheduled_check_in_time: check_in_time,
      luggage_info: luggage_info,
    });

  if (error) {
    return res.redirect(
      "/dashboard?message=Some error occured, please try again!",
    );
  }

  return res.redirect("/dashboard?message=Check-In Scheduled Succesfully!");
});

app.listen(port);
