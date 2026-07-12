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
 * Submit Level 1: Basic Info (Auto-Approves)
 */
async function submitLevel1(request, reply) {
    try {
        const { bvn, nin } = request.body;
        
        if (!bvn && !nin) {
            return reply.status(400).send({ success: false, message: 'BVN or NIN is required.' });
        }

        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc) kyc = new KYC({ user: request.user._id });

        // Save data
        if (!kyc.data) kyc.data = {};
        kyc.data.bvn = bvn;
        kyc.data.nin = nin;
        
        // Upgrade Level
        kyc.currentLevel = 1; 
        await kyc.save();

        // Update the main User model so the Dashboard instantly knows they are Level 1
        await User.findByIdAndUpdate(request.user._id, { kycLevel: 1 });

        reply.send({ success: true, message: 'Level 1 Verification Successful!' });
    } catch (error) {
        console.error('Level 1 Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to process Level 1 verification.' });
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

        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc || kyc.currentLevel < 1) {
            return reply.status(400).send({ success: false, message: 'You must complete Level 1 first.' });
        }

        kyc.data.idType = idType;
        kyc.data.idNumber = idNumber;
        kyc.data.idImage = idImage; // Stores the secure Base64 string
        kyc.data.selfieImage = selfieImage;

        // Push to Level 2, but mark as pending for Admin review
        kyc.currentLevel = 2;
        kyc.status = 'pending';
        await kyc.save();

        reply.send({ success: true, message: 'Level 2 Documents submitted! Please wait for admin approval.' });
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

        let kyc = await KYC.findOne({ user: request.user._id });
        if (!kyc || kyc.currentLevel < 2) {
            return reply.status(400).send({ success: false, message: 'You must complete Level 2 first.' });
        }

        kyc.data.address = address;
        kyc.data.city = city;
        kyc.data.state = state;

        kyc.currentLevel = 3;
        kyc.status = 'pending';
        await kyc.save();

        reply.send({ success: true, message: 'Level 3 Address submitted! Please wait for admin approval.' });
    } catch (error) {
        console.error('Level 3 Error:', error);
        reply.status(500).send({ success: false, message: 'Failed to process address verification.' });
    }
}

module.exports = {
    getKYC,
    submitLevel1,
    submitLevel2,
    submitLevel3
};
