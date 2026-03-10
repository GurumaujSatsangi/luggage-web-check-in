import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import ejs from "ejs";
import session from "express-session";
import { fileURLToPath } from "url";
import path from "path";
import multer from 'multer';
import { createClient } from '@supabase/supabase-js'

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

const app = express();
app.use(express.static("public"));
const upload = multer({ storage: multer.memoryStorage() });
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));


const port = Number(process.env.PORT) || 5000;

app.get("/",async(req,res)=>{
    return res.render("home.ejs");
})

app.get("/dashboard",async(req,res)=>{
    return res.render("dashboard.ejs");
})

app.post("/schedule-check-in", async(req,res)=>{
    const {check_in_date, check_out_date, check_in_time, check_out_time, luggage_info, image} = req.body;

})

app.listen(port)