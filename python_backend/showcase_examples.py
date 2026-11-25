from __future__ import annotations

from typing import Any

SHOWCASE_EXAMPLES: list[dict[str, Any]] = [
    {
        "id": "ecommerce_multipath",
        "title": "E-Commerce Multi-Path & Anomalies",
        "category": "Multi-Path Graph Routing",
        "description": (
            "6-table commerce graph with a corrupted legacy shortcut (Orders.legacy_customer_id) "
            "alongside a clean verified path (Orders -> Invoices -> Customers), plus casing fragmentation and an order outlier."
        ),
        "highlightFeature": "Generates multiple graph-path SQL candidates, scores resilience, and highlights Selected vs Not-Selected paths.",
        "mode": "database",
        "sampleQuestions": [
            "Show total verified order amount and order count per customer name and region",
            "Which warehouse shipped the highest total quantity of electronics products?",
            "List all customers whose average order amount exceeds 300",
        ],
        "sqlSeed": """
CREATE TABLE Customers (
  customer_id INTEGER PRIMARY KEY,
  customer_name TEXT NOT NULL,
  region TEXT,
  tier TEXT
);

CREATE TABLE Warehouses (
  warehouse_id INTEGER PRIMARY KEY,
  warehouse_name TEXT NOT NULL,
  city TEXT NOT NULL
);

CREATE TABLE Products (
  product_id INTEGER PRIMARY KEY,
  product_name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit_price REAL NOT NULL
);

CREATE TABLE Invoices (
  invoice_id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  issued_date TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES Customers(customer_id)
);

CREATE TABLE Orders (
  order_id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL,
  legacy_customer_id INTEGER,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  total_amount REAL,
  order_date TEXT NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES Invoices(invoice_id),
  FOREIGN KEY (legacy_customer_id) REFERENCES Customers(customer_id),
  FOREIGN KEY (product_id) REFERENCES Products(product_id)
);

CREATE TABLE Shipments (
  shipment_id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  carrier TEXT,
  delivery_days INTEGER,
  FOREIGN KEY (order_id) REFERENCES Orders(order_id),
  FOREIGN KEY (warehouse_id) REFERENCES Warehouses(warehouse_id)
);

INSERT INTO Customers VALUES
  (1, 'Aarav Mehta', 'North America', 'Enterprise'),
  (2, 'Elena Rostova', 'north america ', 'Enterprise'),
  (3, 'Liam OConnor', 'Europe', 'Growth'),
  (4, 'Sofia Chen', 'Asia Pacific', 'Enterprise'),
  (5, 'Marcus Vance', 'Europe', NULL),
  (6, 'Priya Nair', 'Asia Pacific', 'Growth');

INSERT INTO Warehouses VALUES
  (10, 'Newark Hub', 'Newark'),
  (20, 'Rotterdam Depot', 'Rotterdam'),
  (30, 'Singapore Port', 'Singapore');

INSERT INTO Products VALUES
  (101, 'Edge Telemetry Gateway', 'Electronics', 420.0),
  (102, 'Industrial Thermal Sensor', 'Electronics', 180.0),
  (103, 'Carbon Rack Enclosure', 'Hardware', 650.0),
  (104, 'Precision Fiber Switch', 'Electronics', 510.0);

INSERT INTO Invoices VALUES
  (1001, 1, '2026-01-12', 'Paid'),
  (1002, 2, '2026-01-15', 'Paid'),
  (1003, 3, '2026-01-19', 'Paid'),
  (1004, 4, '2026-02-02', 'Paid'),
  (1005, 5, '2026-02-08', 'Pending'),
  (1006, 6, '2026-02-14', 'Paid'),
  (1007, 1, '2026-02-21', 'Paid'),
  (1008, 4, '2026-03-01', 'Paid');

INSERT INTO Orders VALUES
  (501, 1001, 1, 101, 2, 840.0, '2026-01-12'),
  (502, 1002, 999, 102, 3, 540.0, '2026-01-15'),
  (503, 1003, NULL, 103, 1, 650.0, '2026-01-19'),
  (504, 1004, 4, 104, 2, 1020.0, '2026-02-02'),
  (505, 1005, 888, 102, 2, NULL, '2026-02-08'),
  (506, 1006, NULL, 101, 1, 420.0, '2026-02-14'),
  (507, 1007, 1, 104, 1, 510.0, '2026-02-21'),
  (508, 1008, 4, 103, 2, 98500.0, '2026-03-01');

INSERT INTO Shipments VALUES
  (701, 501, 10, 'FedEx Freight', 3),
  (702, 502, 10, 'DHL Express', 4),
  (703, 503, 20, 'Maersk Air', 5),
  (704, 504, 30, 'DHL Express', 2),
  (705, 505, 20, 'N/A', 6),
  (706, 506, 30, 'DHL Express', 3),
  (707, 507, 10, 'FedEx Freight', 2),
  (708, 508, 30, 'DHL Express', 4);
""",
    },
    {
        "id": "hr_missing_imputation",
        "title": "HR Payroll & Missing Imputation",
        "category": "Missing Value Imputation",
        "description": (
            "Workforce and department payroll database with intentional NULL and N/A gaps in salary, "
            "bonus, and office location, plus a negative salary domain error."
        ),
        "highlightFeature": "Detects missing values, approximates them via peer-group statistics, and explicitly tags GUESSED / FILLED cells.",
        "mode": "database",
        "sampleQuestions": [
            "Show each employee name, department name, salary, and bonus",
            "What is the average salary and total headcount by department?",
            "Find all employees assigned to active cloud projects",
        ],
        "sqlSeed": """
CREATE TABLE Departments (
  dept_id INTEGER PRIMARY KEY,
  dept_name TEXT NOT NULL,
  cost_center TEXT NOT NULL
);

CREATE TABLE Employees (
  emp_id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  dept_id INTEGER NOT NULL,
  role_level TEXT NOT NULL,
  salary REAL,
  bonus REAL,
  office_city TEXT,
  FOREIGN KEY (dept_id) REFERENCES Departments(dept_id)
);

CREATE TABLE Projects (
  project_id INTEGER PRIMARY KEY,
  project_name TEXT NOT NULL,
  dept_id INTEGER NOT NULL,
  budget REAL,
  FOREIGN KEY (dept_id) REFERENCES Departments(dept_id)
);

CREATE TABLE Assignments (
  assignment_id INTEGER PRIMARY KEY,
  emp_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  allocation_pct INTEGER,
  FOREIGN KEY (emp_id) REFERENCES Employees(emp_id),
  FOREIGN KEY (project_id) REFERENCES Projects(project_id)
);

INSERT INTO Departments VALUES
  (1, 'Engineering', 'CC-100'),
  (2, 'Data Science', 'CC-200'),
  (3, 'Product Design', 'CC-300');

INSERT INTO Employees VALUES
  (101, 'Nadia Kapoor', 1, 'Senior', 142000, 18000, 'San Francisco'),
  (102, 'Lucas Meyer', 1, 'Senior', 138000, 16500, 'San Francisco'),
  (103, 'Hannah Brooks', 1, 'Senior', NULL, 17000, 'N/A'),
  (104, 'Devon Brooks', 1, 'Mid', 112000, NULL, 'Austin'),
  (105, 'Rohan Verma', 2, 'Senior', 148000, 21000, 'New York'),
  (106, 'Chloe Martin', 2, 'Senior', 152000, 22000, 'New York'),
  (107, 'Tariq Al-Mansoor', 2, 'Senior', NULL, NULL, ''),
  (108, 'Grace Lin', 3, 'Mid', 105000, 11000, 'Seattle'),
  (109, 'Mateo Silva', 3, 'Mid', -45000, 10500, 'Seattle'),
  (110, 'Zoe Foster', 3, 'Mid', 108000, NULL, 'Seattle');

INSERT INTO Projects VALUES
  (201, 'Cloud Query Engine', 1, 640000),
  (202, 'Anomaly Telemetry', 2, 490000),
  (203, 'Graph Workspace UI', 3, NULL);

INSERT INTO Assignments VALUES
  (1, 101, 201, 80),
  (2, 103, 201, 100),
  (3, 105, 202, 90),
  (4, 107, 202, 75),
  (5, 108, 203, 100),
  (6, 110, 203, 60);
""",
    },
    {
        "id": "clinical_self_healing",
        "title": "Clinical Trial & Sensor Repair",
        "category": "Anomaly & Self-Healing",
        "description": (
            "Biomedical trial dataset with sensor spike outliers (systolic BP 980 mmHg), "
            "casing drift in trial arms, and missing biomarker scores."
        ),
        "highlightFeature": "Showcases IQR outlier detection, one-click anomaly clearing, and 5-retry iterative SQL repair.",
        "mode": "database",
        "sampleQuestions": [
            "Calculate average systolic blood pressure and biomarker score per trial arm",
            "Which patients have recorded measurements above 140 systolic_bp?",
            "List patient names alongside their prescribed medication dosage",
        ],
        "sqlSeed": """
CREATE TABLE Trials (
  trial_id INTEGER PRIMARY KEY,
  trial_name TEXT NOT NULL,
  sponsor TEXT NOT NULL
);

CREATE TABLE Patients (
  patient_uid INTEGER PRIMARY KEY,
  patient_name TEXT NOT NULL,
  age INTEGER NOT NULL,
  trial_id INTEGER NOT NULL,
  trial_arm TEXT NOT NULL,
  FOREIGN KEY (trial_id) REFERENCES Trials(trial_id)
);

CREATE TABLE Medications (
  med_id INTEGER PRIMARY KEY,
  med_name TEXT NOT NULL,
  dosage_mg INTEGER NOT NULL
);

CREATE TABLE LabMeasurements (
  measurement_id INTEGER PRIMARY KEY,
  patient_uid INTEGER NOT NULL,
  med_id INTEGER NOT NULL,
  systolic_bp REAL,
  biomarker_score REAL,
  visit_week INTEGER NOT NULL,
  FOREIGN KEY (patient_uid) REFERENCES Patients(patient_uid),
  FOREIGN KEY (med_id) REFERENCES Medications(med_id)
);

INSERT INTO Trials VALUES
  (1, 'CardioShield Phase III', 'BioNova'),
  (2, 'NeuroPulse Phase II', 'Helix Labs');

INSERT INTO Patients VALUES
  (1, 'Arthur Pendelton', 58, 1, 'Treatment A'),
  (2, 'Beatrice Zhao', 62, 1, 'treatment a '),
  (3, 'Carlos Mendez', 54, 1, 'Placebo'),
  (4, 'Diana Novak', 49, 2, 'Treatment A'),
  (5, 'Edward Kim', 67, 2, 'Placebo'),
  (6, 'Fatima Zahra', 51, 1, 'Placebo');

INSERT INTO Medications VALUES
  (11, 'CardioStat', 25),
  (12, 'PlaceboSaline', 0),
  (13, 'NeuroCalm', 40);

INSERT INTO LabMeasurements VALUES
  (1, 1, 11, 128, 7.4, 4),
  (2, 2, 11, 134, NULL, 4),
  (3, 3, 12, 146, 5.1, 4),
  (4, 4, 13, 980, 8.2, 4),
  (5, 5, 12, 139, 4.9, 4),
  (6, 6, 12, 142, NULL, 4),
  (7, 1, 11, 124, 7.8, 8),
  (8, 2, 11, 131, 7.5, 8);
""",
    },
    {
        "id": "university_spider_style",
        "title": "University Transcripts (Spider Graph)",
        "category": "Clean Relational Graph",
        "description": (
            "5-table academic schema modeled after Spider benchmark topology with Students, "
            "Departments, Instructors, Courses, and Enrollments."
        ),
        "highlightFeature": "Demonstrates clean column-to-column FK wiring and relational Query Graph execution DAGs.",
        "mode": "database",
        "sampleQuestions": [
            "Find the names of students who earned an A in Computer Science courses",
            "How many students are enrolled in each department ordered by enrollment count descending?",
            "Which instructor teaches the course with the highest average credits?",
        ],
        "sqlSeed": """
CREATE TABLE Departments (
  dept_id INTEGER PRIMARY KEY,
  dept_name TEXT NOT NULL,
  building TEXT NOT NULL
);

CREATE TABLE Instructors (
  instructor_id INTEGER PRIMARY KEY,
  instructor_name TEXT NOT NULL,
  dept_id INTEGER NOT NULL,
  FOREIGN KEY (dept_id) REFERENCES Departments(dept_id)
);

CREATE TABLE Courses (
  course_id INTEGER PRIMARY KEY,
  course_code TEXT NOT NULL,
  title TEXT NOT NULL,
  credits INTEGER NOT NULL,
  dept_id INTEGER NOT NULL,
  instructor_id INTEGER NOT NULL,
  FOREIGN KEY (dept_id) REFERENCES Departments(dept_id),
  FOREIGN KEY (instructor_id) REFERENCES Instructors(instructor_id)
);

CREATE TABLE Students (
  student_id INTEGER PRIMARY KEY,
  student_name TEXT NOT NULL,
  major_dept_id INTEGER NOT NULL,
  gpa REAL NOT NULL,
  FOREIGN KEY (major_dept_id) REFERENCES Departments(dept_id)
);

CREATE TABLE Enrollments (
  enrollment_id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  semester TEXT NOT NULL,
  grade TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES Students(student_id),
  FOREIGN KEY (course_id) REFERENCES Courses(course_id)
);

INSERT INTO Departments VALUES
  (1, 'Computer Science', 'Gates Hall'),
  (2, 'Mathematics', 'Euler Center'),
  (3, 'Physics', 'Bohr Pavilion');

INSERT INTO Instructors VALUES
  (10, 'Dr. Alan Turing', 1),
  (11, 'Dr. Ada Lovelace', 1),
  (12, 'Dr. Emmy Noether', 2),
  (13, 'Dr. Richard Feynman', 3);

INSERT INTO Courses VALUES
  (101, 'CS-401', 'Database Systems', 4, 1, 10),
  (102, 'CS-450', 'Machine Learning', 4, 1, 11),
  (103, 'MATH-310', 'Abstract Algebra', 3, 2, 12),
  (104, 'PHYS-220', 'Quantum Mechanics', 4, 3, 13);

INSERT INTO Students VALUES
  (1001, 'Maya Lin', 1, 3.92),
  (1002, 'Ethan Cole', 1, 3.65),
  (1003, 'Sora Takahashi', 2, 3.88),
  (1004, 'Noah Patel', 3, 3.51),
  (1005, 'Clara Oswald', 1, 3.79);

INSERT INTO Enrollments VALUES
  (1, 1001, 101, 'Fall 2026', 'A'),
  (2, 1001, 102, 'Fall 2026', 'A'),
  (3, 1002, 101, 'Fall 2026', 'B+'),
  (4, 1003, 103, 'Fall 2026', 'A'),
  (5, 1004, 104, 'Fall 2026', 'A-'),
  (6, 1005, 101, 'Fall 2026', 'A'),
  (7, 1003, 102, 'Fall 2026', 'B');
""",
    },
    {
        "id": "text_only_mode",
        "title": "Text-Only (No Database File)",
        "category": "Schema-Free Text-to-SQL",
        "description": (
            "Pure natural-language Text-to-SQL mode when no .sql or .db file is provided. "
            "Infers relational DDL, generates SQL, and visualizes the Query Graph."
        ),
        "highlightFeature": "Works with zero files provided—generates SQL and inferred schema directly from text.",
        "mode": "text_only",
        "sampleQuestions": [
            "Find the top 5 customers who spent more than $2,000 in the last 90 days across all orders",
            "Calculate monthly recurring revenue growth rate by subscription plan for 2026",
            "List flights with delays longer than 45 minutes departing from New York airports",
        ],
        "sqlSeed": "",
    },
]
