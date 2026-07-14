const KYC = require('../models/KYC');
const User = require('../models/User');

/**
 * Get Current KYC Status for the User
 */
async function getKYC(request, reply) {
    try {
        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc) {
            kyc = new KYC({ user: request.user._id, currentLevel: 0, status: 'pending' });
            await kyc.save();
        }
        reply.send({ success: true, kyc: { currentLevel: kyc.currentLevel, status: kyc.status } });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to retrieve KYC data.' });
    }
}

/**
 * Submit Level 1: Basic Info
 */
async function submitLevel1(request, reply) {
    try {
        const { bvn, nin } = request.body;
        
        if (!bvn && !nin) return reply.status(400).send({ success: false, message: 'BVN or NIN is required.' });
        if (bvn && !/^\d{11}$/.test(bvn)) return reply.status(400).send({ success: false, message: 'BVN must be exactly 11 digits.' });
        if (nin && !/^\d{11}$/.test(nin)) return reply.status(400).send({ success: false, message: 'NIN must be exactly 11 digits.' });

        // ANTI-DUPLICATION ENGINE
        const orConditions = [];
        if (bvn) orConditions.push({ 'level1.bvn': bvn });
        if (nin) orConditions.push({ 'level1.nin': nin });

        const duplicateCheck = await KYC.findOne({ $or: orConditions, user: { $ne: request.user._id } });
        if (duplicateCheck) {
            return reply.status(403).send({ success: false, message: 'SECURITY ALERT: This BVN or NIN is already linked to an existing NATERPAY account.' });
        }

        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc) kyc = new KYC({ user: request.user._id });

        kyc.currentLevel = 1; 
        // This schema method saves the data securely to level1 and sets status to 'under_review'
        await kyc.submitLevel1(bvn, nin);

        reply.send({ success: true, message: 'Details submitted! Awaiting global verification by an Administrator.' });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to process verification.' });
    }
}

/**
 * Submit Level 2: Document Uploads
 */
async function submitLevel2(request, reply) {
    try {
        const { idType, idNumber, idImage, selfieImage } = request.body;
        if (!idType || !idNumber || !idImage || !selfieImage) return reply.status(400).send({ success: false, message: 'All Document fields are required.' });

        const user = await User.findById(request.user._id);
        let kyc = await KYC.findOne({ user: request.user._id });
        
        if (!kyc || user.kycLevel < 1) {
            return reply.status(400).send({ success: false, message: 'Your TIER 1 Identity must be APPROVED by an Admin before submitting TIER 2.' });
        }

        kyc.currentLevel = 2;
        await kyc.submitLevel2(idType, idNumber, idImage, selfieImage);

        reply.send({ success: true, message: 'Documents submitted! Please wait for manual admin review.' });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to process document uploads.' });
    }
}

/**
 * Submit Level 3: Address Proof
 */
async function submitLevel3(request, reply) {
    try {
        const { address, city, state } = request.body;
        if (!address || !city || !state) return reply.status(400).send({ success: false, message: 'Complete address details are required.' });

        const user = await User.findById(request.user._id);
        let kyc = await KYC.findOne({ user: request.user._id });
        
        if (!kyc || user.kycLevel < 2) {
            return reply.status(400).send({ success: false, message: 'Your TIER 2 Documents must be APPROVED before submitting Address.' });
        }

        kyc.currentLevel = 3;
        await kyc.submitLevel3(address, city, state, null);

        reply.send({ success: true, message: 'Address submitted! Please wait for final admin approval.' });
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Failed to process address verification.' });
    }
}

module.exports = { getKYC, submitLevel1, submitLevel2, submitLevel3 };
