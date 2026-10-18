
-- Admin Users Table (Partitioned by admin_type: 'infrastructure' and 'main')
CREATE TABLE IF NOT EXISTS admin_users (
    id serial PRIMARY KEY,
    username varchar(50) NOT NULL,
    password varchar(255) NOT NULL, -- Strictly stores bcrypt password hashes
    admin_type varchar(50) NOT NULL DEFAULT 'main',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    last_login TIMESTAMP WITH TIME ZONE NULL,
    CONSTRAINT uq_admin_users_type_username UNIQUE (admin_type, username)
);

-- Rice Requirements Table
CREATE TABLE IF NOT EXISTS rice_requirements (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    u_dise TEXT NOT NULL,
    school_name TEXT,
    quarter TEXT NOT NULL,
    year INTEGER NOT NULL,
    req_bv NUMERIC DEFAULT 0,
    req_c1_5 NUMERIC DEFAULT 0,
    req_c5 NUMERIC DEFAULT 0,
    req_c6_8 NUMERIC DEFAULT 0,
    total_primary_kg NUMERIC DEFAULT 0,
    total_upper_kg NUMERIC DEFAULT 0,
    submission_date TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    UNIQUE(u_dise, quarter, year)
);

-- School Infrastructure Table
CREATE TABLE IF NOT EXISTS school_infrastructure (
    u_dise TEXT PRIMARY KEY,
    school_name TEXT,
    circle_name TEXT,
    category TEXT,
    kitchen_status TEXT,
    kitchen_year TEXT,
    repair_grant_status TEXT,
    repair_grant_year TEXT,
    dining_status TEXT,
    dining_fund TEXT,
    nutrition_garden TEXT,
    kitchen_device_status TEXT,
    kitchen_device_year TEXT,
    toilet_separate TEXT,
    electric_status TEXT,
    water_facilities TEXT,
    water_purifier TEXT,
    remarks TEXT,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Student Enrolment Table
CREATE TABLE IF NOT EXISTS student_enrolment (
    u_dise TEXT PRIMARY KEY,
    school_name TEXT,
    circle_name TEXT,
    gp_name TEXT,
    catergory TEXT,
    
    pre_primary INTEGER DEFAULT 0,
    class_1 INTEGER DEFAULT 0,
    class_2 INTEGER DEFAULT 0,
    class_3 INTEGER DEFAULT 0,
    class_4 INTEGER DEFAULT 0,
    class_5 INTEGER DEFAULT 0,
    class_6 INTEGER DEFAULT 0,
    class_7 INTEGER DEFAULT 0,
    class_8 INTEGER DEFAULT 0,
    
    male_sc INTEGER DEFAULT 0,
    male_st INTEGER DEFAULT 0,
    male_obc INTEGER DEFAULT 0,
    male_minority INTEGER DEFAULT 0,
    male_others INTEGER DEFAULT 0,
    
    female_sc INTEGER DEFAULT 0,
    female_st INTEGER DEFAULT 0,
    female_obc INTEGER DEFAULT 0,
    female_minority INTEGER DEFAULT 0,
    female_others INTEGER DEFAULT 0,
    
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- MDM Monthly Report Table
CREATE TABLE IF NOT EXISTS mdm_monthly_report (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    u_dise TEXT NOT NULL,
    school_name TEXT,
    circle_name TEXT,
    gp_name TEXT,
    month_name TEXT NOT NULL,
    year INTEGER NOT NULL,
    
    p_days INTEGER DEFAULT 0,
    up_days INTEGER DEFAULT 0,
    p_actual INTEGER DEFAULT 0,
    up_actual INTEGER DEFAULT 0,
    p_meals INTEGER DEFAULT 0,
    up_meals INTEGER DEFAULT 0,
    
    bv_days INTEGER DEFAULT 0,
    bv_actual INTEGER DEFAULT 0,
    bv_meals INTEGER DEFAULT 0,
    
    -- Fund Details (11 MDCF Components)
    cc_bv_open NUMERIC DEFAULT 0, cc_bv_recv NUMERIC DEFAULT 0, cc_bv_exp NUMERIC DEFAULT 0, cc_bv_close NUMERIC DEFAULT 0,
    cc_p_open NUMERIC DEFAULT 0, cc_p_recv NUMERIC DEFAULT 0, cc_p_exp NUMERIC DEFAULT 0, cc_p_close NUMERIC DEFAULT 0,
    cc_up_open NUMERIC DEFAULT 0, cc_up_recv NUMERIC DEFAULT 0, cc_up_exp NUMERIC DEFAULT 0, cc_up_close NUMERIC DEFAULT 0,
    
    bi_open NUMERIC DEFAULT 0, bi_recv NUMERIC DEFAULT 0, bi_exp NUMERIC DEFAULT 0, bi_close NUMERIC DEFAULT 0,
    lpg_open NUMERIC DEFAULT 0, lpg_recv NUMERIC DEFAULT 0, lpg_exp NUMERIC DEFAULT 0, lpg_close NUMERIC DEFAULT 0,
    nutri_open NUMERIC DEFAULT 0, nutri_recv NUMERIC DEFAULT 0, nutri_exp NUMERIC DEFAULT 0, nutri_close NUMERIC DEFAULT 0,
    mme_open NUMERIC DEFAULT 0, mme_recv NUMERIC DEFAULT 0, mme_exp NUMERIC DEFAULT 0, mme_close NUMERIC DEFAULT 0,
    kd_open NUMERIC DEFAULT 0, kd_recv NUMERIC DEFAULT 0, kd_exp NUMERIC DEFAULT 0, kd_close NUMERIC DEFAULT 0,
    ks_open NUMERIC DEFAULT 0, ks_recv NUMERIC DEFAULT 0, ks_exp NUMERIC DEFAULT 0, ks_close NUMERIC DEFAULT 0,
    ng_open NUMERIC DEFAULT 0, ng_recv NUMERIC DEFAULT 0, ng_exp NUMERIC DEFAULT 0, ng_close NUMERIC DEFAULT 0,
    bc_open NUMERIC DEFAULT 0, bc_recv NUMERIC DEFAULT 0, bc_exp NUMERIC DEFAULT 0, bc_close NUMERIC DEFAULT 0,
    
    cch_open NUMERIC DEFAULT 0, cch_recv NUMERIC DEFAULT 0, cch_exp NUMERIC DEFAULT 0, cch_close NUMERIC DEFAULT 0,
    
    bank_match TEXT DEFAULT 'YES',
    bank_passbook_balance NUMERIC DEFAULT 0,
    bank_balance_date TEXT,
    fund_details_json JSONB,
    
    -- Food Grains Details - Rice (KG)
    rice_bv_open NUMERIC DEFAULT 0, rice_bv_recv NUMERIC DEFAULT 0, rice_bv_cons NUMERIC DEFAULT 0, rice_bv_close NUMERIC DEFAULT 0,
    rice_p_open NUMERIC DEFAULT 0, rice_p_recv NUMERIC DEFAULT 0, rice_p_cons NUMERIC DEFAULT 0, rice_p_close NUMERIC DEFAULT 0,
    rice_up_open NUMERIC DEFAULT 0, rice_up_recv NUMERIC DEFAULT 0, rice_up_cons NUMERIC DEFAULT 0, rice_up_close NUMERIC DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    UNIQUE(u_dise, month_name, year)
);

-- Infrastructure Config Table (for managing field visibility & lock permissions)
CREATE TABLE IF NOT EXISTS infrastructure_config (
    key VARCHAR(100) PRIMARY KEY,
    label VARCHAR(255) NOT NULL,
    is_locked BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- School Master Table (Authoritative Master Data for All Schools)
CREATE TABLE IF NOT EXISTS school_master (
    udise_code TEXT PRIMARY KEY,
    school_name TEXT NOT NULL,
    catergory TEXT NOT NULL,
    circle_name TEXT NOT NULL,
    gp_name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS (Row Level Security) - Optional but recommended
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE rice_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_infrastructure ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_enrolment ENABLE ROW LEVEL SECURITY;
ALTER TABLE mdm_monthly_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE infrastructure_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_master ENABLE ROW LEVEL SECURITY;

-- Create policies
-- Secure policy for admin_users: strictly restricted to service_role to protect password hashes
REVOKE ALL ON admin_users FROM anon;
REVOKE ALL ON admin_users FROM authenticated;
REVOKE ALL ON admin_users FROM public;
CREATE POLICY "service_role_manage_admin_users" ON admin_users FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Application data policies
CREATE POLICY "Public Access" ON rice_requirements FOR ALL USING (true);
CREATE POLICY "Public Access" ON school_infrastructure FOR ALL USING (true);
CREATE POLICY "Public Access" ON student_enrolment FOR ALL USING (true);
CREATE POLICY "Public Access" ON mdm_monthly_report FOR ALL USING (true);
CREATE POLICY "Public Access" ON infrastructure_config FOR ALL USING (true);
CREATE POLICY "Public Access" ON school_master FOR ALL USING (true);

