const KYC = require('../models/KYC');
const User = require('../models/User');

/**
 * Get Current KYC Status for the User
 */
async function getKYC(request, reply) {
    try {
        let kyc = await KYC.findOne({ user: request.user._id });
        
        // If the user doesn't have a KYC record yet, create an empty one
        if (!kyc) {
            kyc = new KYC({ user: request.user._id, currentLevel: 0, status: 'pending' });
            await kyc.save();
        }

        reply.send({
            success: true,
            kyc: {
                currentLevel: kyc.currentLevel,
                status: kyc.status
            }
        });
    } catch (error) {
        console.error('KYC Fetch Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to retrieve KYC data.' });
    }
}

/**
 * Submit Level 1: Basic Info (STRICT MODE: No Auto-Approval)
 */
async function submitLevel1(request, reply) {
    try {
        const { bvn, nin } = request.body;
        
        if (!bvn && !nin) {
            return reply.status(400).send({ success: false, message: 'BVN or NIN is required.' });
        }

        // FORMAT VALIDATION: Must be exactly 11 digits
        if (bvn && !/^\d{11}$/.test(bvn)) return reply.status(400).send({ success: false, message: 'BVN must be exactly 11 digits.' });
        if (nin && !/^\d{11}$/.test(nin)) return reply.status(400).send({ success: false, message: 'NIN must be exactly 11 digits.' });

        // ANTI-DUPLICATION ENGINE: 1 Data = 1 Account
        const duplicateCheck = await KYC.findOne({
            $or: [
                { 'data.bvn': bvn },
                { 'data.nin': nin }
            ],
            user: { $ne: request.user._id } // Check everyone EXCEPT this user
        });

        if (duplicateCheck) {
            return reply.status(403).send({ success: false, message: 'SECURITY ALERT: This BVN or NIN is already linked to an existing NATERPAY account.' });
        }

        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc) kyc = new KYC({ user: request.user._id });

        // Save data
        if (!kyc.data) kyc.data = {};
        if (bvn) kyc.data.bvn = bvn;
        if (nin) kyc.data.nin = nin;
        
        // Push to Level 1, but STRICTLY MARK AS PENDING.
        // User.kycLevel is NOT updated yet. Admin must approve first.
        kyc.currentLevel = 1; 
        kyc.status = 'pending';
        await kyc.save();

        reply.send({ success: true, message: 'Details submitted! Awaiting global verification by an Administrator.' });
    } catch (error) {
        console.error('Level 1 Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to process verification.' });
    }
}

/**
 * Submit Level 2: Document Uploads (Goes to Pending)
 */
async function submitLevel2(request, reply) {
    try {
        const { idType, idNumber, idImage, selfieImage } = request.body;
        
        if (!idType || !idNumber || !idImage || !selfieImage) {
            return reply.status(400).send({ success: false, message: 'All Document fields are required.' });
        }

        const user = await User.findById(request.user._id);
        let kyc = await KYC.findOne({ user: request.user._id });
        
        // Strict check: Admin MUST have approved Level 1 first (User.kycLevel tracks approved levels)
        if (!kyc || user.kycLevel < 1) {
            return reply.status(400).send({ success: false, message: 'Your TIER 1 Identity must be APPROVED by an Admin before submitting TIER 2.' });
        }

        kyc.data.idType = idType;
        kyc.data.idNumber = idNumber;
        kyc.data.idImage = idImage; 
        kyc.data.selfieImage = selfieImage;

        // Push to Level 2 and mark as pending for Admin review
        kyc.currentLevel = 2;
        kyc.status = 'pending';
        await kyc.save();

        reply.send({ success: true, message: 'Documents submitted! Please wait for manual admin review.' });
    } catch (error) {
        console.error('Level 2 Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to process document uploads.' });
    }
}

/**
 * Submit Level 3: Address Proof (Goes to Pending)
 */
async function submitLevel3(request, reply) {
    try {
        const { address, city, state } = request.body;
        
        if (!address || !city || !state) {
            return reply.status(400).send({ success: false, message: 'Complete address details are required.' });
        }

        const user = await User.findById(request.user._id);
        let kyc = await KYC.findOne({ user: request.user._id });
        
        // Strict check: Admin MUST have approved Level 2 first
        if (!kyc || user.kycLevel < 2) {
            return reply.status(400).send({ success: false, message: 'Your TIER 2 Documents must be APPROVED before submitting Address.' });
        }

        kyc.data.address = address;
        kyc.data.city = city;
        kyc.data.state = state;

        kyc.currentLevel = 3;
        kyc.status = 'pending';
        await kyc.save();

        reply.send({ success: true, message: 'Address submitted! Please wait for final admin approval.' });
    } catch (error) {
        console.error('Level 3 Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to process address verification.' });
    }
}

module.exports = { getKYC, submitLevel1, submitLevel2, submitLevel3 };
