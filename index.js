//requires
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const { resolveSoa } = require("dns/promises");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
//function call
const app = express();
const port = process.env.PORT || 5000;

//middleware
app.use(cors());
app.use(express.json());

//mongodb configuration
const url = `mongodb+srv://${process.env.DB_user}:${process.env.DB_password}@cluster0.cu6wtcv.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(url, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });
const database = client.db("doctorsPortal");

//verify user with json token and user localstorage token
function verifyJwt(req, res, next) {
    const userTokens = req.headers.authorization;

    if (!userTokens) {
        return res.status(401).send({ message: "Unauthorized access" });
    }
    jwt.verify(userTokens, process.env.USER_TOKEN, (err, decoded) => {
        if (err) {
            return res.status(403).send({ message: "unauthorized user" });
        }
        req.decoded = decoded;

        next();
    });
}

const appointmentOptionsCollection = database.collection("appointmentOptions");
const bookingsCollection = database.collection("bookings");
const usersCollection = database.collection("usersData");
const doctorsCollection = database.collection("doctors");
const PaymentsCollection = database.collection("Payments");

//server router
async function run() {
    try {
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.userEmail;
            const adminquery = { email: decodedEmail };

            const userData = await usersCollection.findOne(adminquery);
            if (userData?.role !== "Admin") {
                return res.send({ message: "You are not an admin" });
            }
            next();
        };

        //get appointment options
        app.get("/appointmentOptions", async (req, res) => {
            const date = req.query.date;

            const query = {};
            const selected = appointmentOptionsCollection.find(query);
            const options = await selected.toArray();
            //check bookings data in user selected date
            const bookingQuery = { appointmentDate: date };
            const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();

            options.forEach((option) => {
                // console.log(option);
                //booking treatment name
                const optionsBooked = alreadyBooked.filter((booked) => booked.treatmentName === option.name);

                const bookedSlots = optionsBooked.map((booked) => booked.slot);

                const remainingSlots = option.slots.filter((slot) => !bookedSlots.includes(slot));
                option.slots = remainingSlots;
            });
            res.send(options);
        });

        //save user data in database & set first user role: admin && return jwt token
        app.put("/setuser", async (req, res) => {
            const user = req.body;
            // console.log(user);
            const queryByEmail = { email: user.email };
            const alluser = {};
            const userEmail = user.email;
            const isAlreadySignUp = await usersCollection.findOne(queryByEmail);
            // console.log(isAlreadySignUp);
            let result = "";

            const token = jwt.sign({ userEmail }, process.env.USER_TOKEN, { expiresIn: "1d" });
            //log in user
            if (isAlreadySignUp) {
                return res.send({ result: { acknowledged: false, message: `welcome back! ${user.name}` }, userToken: token });
            }

            //NewUser user must be admin
            const isFirstUser = await usersCollection.find(alluser).toArray();
            if (!isFirstUser.length) {
                //is first user make admin
                user["role"] = "Admin";
            }

            //save user in database
            result = await usersCollection.insertOne(user);
            if (result.acknowledged) {
                //send token to user localstorage
                res.send({ result, userToken: token });
            } else {
                res.send({ result, userToken: false });
            }
        });

        //set user booking data
        app.post("/bookings", verifyJwt, async (req, res) => {
            const booking = req.body;
            const decodedEmail = req.decoded.userEmail;
            // console.log("line -120 : ", decodedEmail);
            const query = { appointmentDate: booking.appointmentDate, email: decodedEmail, treatmentName: booking.treatmentName };
            const alreadyBooked = await bookingsCollection.find(query).toArray();
            if (alreadyBooked.length) {
                const message = `you already booking on ${booking.appointmentDate}`;
                return res.send({ acknowledged: false, message });
            }
            const result = await bookingsCollection.insertOne(booking);
            res.send(result);
        });
        //is admin check
        app.get("/adminusers", verifyJwt, verifyAdmin, async (req, res) => {
            const email = req.query.email;

            const query = { email: email };
            const users = await usersCollection.findOne(query);
            res.send(users);
        });

        //get user all booking data
        app.get("/bookings", verifyJwt, async (req, res) => {
            const email = req.decoded.userEmail;
            const date = req.query.date;
            // console.log(email, date);
            const query = { email: email, appointmentDate: date };
            const userBookedData = await bookingsCollection.find(query).toArray();

            res.send(userBookedData);
        });
        //delete user bookings data
        app.delete("/bookings/:id", verifyJwt, async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const result = await bookingsCollection.deleteOne(query);
            res.send(result);
        });

        // ---------------------------------------------------------------------------//
        // ---------------------------------------------------------------------------//
        // ---------------------------------------------------------------------------//
        app.get("/appointment-Speciality", async (req, res) => {
            const query = {};
            const result = await appointmentOptionsCollection.find(query).project({ name: 1 }).toArray();

            res.send(result);
        });
        //get specific booking data
        app.get("/bookings/:id", async (req, res) => {
            const id = req.params.id;

            const query = { _id: ObjectId(id) };
            const booking = await bookingsCollection.findOne(query);

            res.send(booking);
        });

        //user payment
        app.post("/create-payment-intent", async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            // console.log(price);
            const paymentIntent = await stripe.paymentIntents.create({
                amount: price * 100,
                currency: "usd",
                payment_method_types: ["card"],
            });

            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });
        //set transaction id
        app.post("/payments", async (req, res) => {
            const payementUser = req.body;
            const bookingId = payementUser.booking_id;
            const query = { _id: ObjectId(bookingId) };
            const updatedoc = { $set: { paid: true } };
            const options = { upsert: true };
            const bookingResult = await bookingsCollection.updateOne(query, updatedoc, options);
            if (bookingResult.modifiedCount > 0) {
                const result = await PaymentsCollection.insertOne(payementUser);
                res.send(result);
            }
        });

        //get all user data from database
        app.get("/users", async (req, res) => {
            const query = {};
            const users = await usersCollection.find(query).toArray();
            res.send(users);
        });
        //delete user from database

        app.delete("/users/:id", verifyJwt, async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const result = await usersCollection.deleteOne(query);

            res.send(result);
        });

        // set user role:admin
        app.put("/Admin/user", verifyJwt, verifyAdmin, async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const updatedoc = { $set: { role: "Admin" } };
            const option = { upsert: true };

            const result = await usersCollection.updateOne(query, updatedoc, option);
            res.send(result);
        });
        //set doctor
        app.post("/doctors", verifyJwt, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const email = req.query.email;
            const speciality = doctor.speciality;

            const queryall = { email: email, speciality: speciality };

            const checkDoctor = await doctorsCollection.findOne(queryall);

            if (checkDoctor) {
                return res.send({ acknowledged: false, message: `${doctor.name} already set in doctors list with ${doctor.speciality} speciality` });
            }
            const result = await doctorsCollection.insertOne(doctor);

            res.send(result);
        });
        app.get("/alldoctors", verifyJwt, verifyAdmin, async (req, res) => {
            const query = {};
            const result = await doctorsCollection.find(query).toArray();

            res.send(result);
        });
        app.delete("/doctors/:id", verifyJwt, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const result = await doctorsCollection.deleteOne(query);
            // console.log(result);
            res.send(result);
        });
    } finally {
    }
}
run().catch((err) => console.log(err));

const codes = require("crypto").randomBytes(64).toString("hex");
// console.log("codes", codes +);

app.get("/", async (req, res) => {
    res.send("doctors portal server is running");
});

//runner
app.listen(port, () => {
    console.log("server is running on", port);
});
