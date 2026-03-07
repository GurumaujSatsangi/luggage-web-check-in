import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import ejs from "ejs";
import session from "express-session";
import { fileURLToPath } from "url";
import path from "path";
import multer from 'multer';
import prismaPkg from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";



dotenv.config();



const { PrismaClient } = prismaPkg;
const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });
const app = express();

const upload = multer({ storage: multer.memoryStorage() });
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));


const port = Number(process.env.PORT) || 3000;

app.get("/",async(req,res)=>{
    return res.render("home.ejs");
})

app.get("/dashboard",async(req,res)=>{
    return res.render("dashboard.ejs");
})

app.listen(port, ()=>{
    console.log("Running on Port " + port);
})