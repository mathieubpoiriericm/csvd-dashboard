"""Every case here is a string ClinicalTrials.gov actually returned."""

import pytest

from pipeline.drug_names import fold_case_variants, normalize_drug_name


class TestDoseAndForm:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Atorvastatin 40 Mg Oral Tablet", "Atorvastatin"),
            ("Atorvastatin 10 mg daily", "Atorvastatin"),
            # The salt fold is TestSaltForms' subject; here it is the
            # packaging that has to go.
            ("Pentoxifylline sustained-release tablets", "Pentoxifylline"),
            ("Tadalafil 20 MG", "Tadalafil"),
            ("Butylphthalide Soft Capsules", "Butylphthalide"),
            ("Naoxuekang Dropping Pills", "Naoxuekang"),
            ("Dapagliflozin 10mg Tab", "Dapagliflozin"),
            ("Edaravone Dexborneol Sublingual Tablets", "Edaravone Dexborneol"),
        ],
    )
    def test_the_agent_survives_its_packaging(self, raw, expected):
        assert normalize_drug_name(raw) == expected

    def test_an_arm_label_wrapping_the_agent_is_removed(self):
        assert (
            normalize_drug_name("high dose group of SaiLuoTong capsule") == "SaiLuoTong"
        )
        assert normalize_drug_name("low dose group of SaiLuoTong") == "SaiLuoTong"


class TestCapitalisation:
    def test_a_lower_case_name_gains_its_capital(self):
        assert normalize_drug_name("aspirin") == "Aspirin"
        assert normalize_drug_name("cilostazol") == "Cilostazol"

    def test_a_name_carrying_its_own_capital_is_left_alone(self):
        """rt-PA is not Rt-PA, and SaiLuoTong is not Sailuotong."""
        assert normalize_drug_name("rt-PA") == "rt-PA"
        assert normalize_drug_name("SaiLuoTong capsule") == "SaiLuoTong"
        assert normalize_drug_name("XYWAV") == "XYWAV"
        assert (
            normalize_drug_name("mouse nerve growth factor")
            == "Mouse nerve growth factor"
        )


class TestParentheses:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Butylphthalide (NBP)", "Butylphthalide"),
            ("Mivelsiran (ALN-APP)", "Mivelsiran"),
            ("Palm tocotrienols complex (HOV-12020)", "Palm tocotrienols complex"),
            ("Isosorbide Mononitrate XL (ISMN)", "Isosorbide Mononitrate"),
            ("Calculus bovis sativus (CBS)", "Calculus bovis sativus"),
            ("acetylsalicyclic acid (ASA)", "Acetylsalicyclic acid"),
        ],
    )
    def test_a_trailing_acronym_is_dropped(self, raw, expected):
        """A radar label is the agent's name; a code earns none of its width."""
        assert normalize_drug_name(raw) == expected

    @pytest.mark.parametrize(
        "raw",
        [
            "Delta-9-tetrahydrocannabinol (delta-THC)",
            "Rifaximin SSD (IR)".replace(" (IR)", " (Ir)"),
        ],
    )
    def test_a_parenthetical_that_is_not_an_acronym_is_kept(self, raw):
        """A lower-case letter anywhere is the discriminator. Zydena
        (Udenafil) and Donepezil hydrochloride (Aricept) also clear this
        rule -- they are rewritten a step later, by TestBrandNames."""
        assert normalize_drug_name(raw) == raw

    def test_an_acronym_that_is_the_whole_name_survives(self):
        assert normalize_drug_name("(ALN-APP)") == "(ALN-APP)"


class TestSaltForms:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Donepezil Hydrochloride", "Donepezil"),
            ("donepezil hcl", "Donepezil"),
            ("Lidocaine Hydrochloride", "Lidocaine"),
            ("Atorvastatin Calcium tablets 20mg", "Atorvastatin"),
            ("galantamine hydrobromide", "Galantamine"),
            ("N Acetylcysteine", "Acetylcysteine"),
        ],
    )
    def test_a_confirmed_salt_form_folds_to_its_ingredient(self, raw, expected):
        assert normalize_drug_name(raw) == expected

    @pytest.mark.parametrize(
        "raw",
        [
            "Isosorbide mononitrate",
            "Choline alphoscerate",
            "Galantamine",
            "NACA",
            "Edaravone Dexborneol",
        ],
    )
    def test_a_fold_that_would_lose_a_moiety_is_not_applied(self, raw):
        """Every one of these is a rename RxNorm or ChEMBL offers and a
        curator refused: the ester, the alfoscerate, the prodrug, a different
        compound, and the dexborneol."""
        assert normalize_drug_name(raw) == raw


class TestCoInterventions:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Donepezil and self-generated memory training", "Donepezil"),
            ("Donepezil and experimenter-administered memory training", "Donepezil"),
            ("Amlodipine+intensive antihypertensive therapy", "Amlodipine"),
            ("Amlodipine+standard antihypertensive therapy", "Amlodipine"),
            ("BAC treatment", "BAC"),
        ],
    )
    def test_the_drug_is_kept_and_what_is_done_beside_it_is_not(self, raw, expected):
        assert normalize_drug_name(raw) == expected

    @pytest.mark.parametrize(
        "raw", ["Placebos", "Regular treatment", "the control group"]
    )
    def test_a_string_naming_no_agent_resolves_to_nothing(self, raw):
        assert normalize_drug_name(raw) is None


class TestCombinations:
    def test_a_fixed_dose_combination_keeps_every_agent(self):
        """TRIDENT's Triple Pill is not amlodipine and must not merge with it."""
        triple = "telmisartan 20 mg + amlodipine 2.5mg + indapamide 1.25mg"
        assert normalize_drug_name(triple) == "Telmisartan, amlodipine and indapamide"

    def test_the_two_spellings_of_that_combination_agree(self):
        spaced = "telmisartan 20 mg + amlodipine 2.5mg + indapamide 1.25mg"
        tight = "telmisartan 20mg + amlodipine 2.5mg +indapamide 1.25mg"
        assert normalize_drug_name(spaced) == normalize_drug_name(tight)

    def test_nbp_expands_to_the_spelling_the_other_five_trials_use(self):
        """NCT03906123's arm is the same agent the Butylphthalide rows carry,
        in the same population, so two labels named one drug in one sector."""
        assert normalize_drug_name("NBP") == "Butylphthalide"

    def test_an_abbreviated_agent_is_expanded_into_the_spelling_the_table_uses(self):
        assert (
            normalize_drug_name("ISMN XL and Cilostazol")
            == "Isosorbide mononitrate and cilostazol"
        )


class TestBrandNames:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Zydena (Udenafil)", "Udenafil"),
            ("Akatinol Memantine 20 mg", "Memantine"),
            ("donepezil hydrochloride (Aricept)", "Donepezil"),
        ],
    )
    def test_a_row_naming_both_a_brand_and_its_generic_keeps_the_generic(
        self, raw, expected
    ):
        assert normalize_drug_name(raw) == expected

    @pytest.mark.parametrize("raw", ["XYWAV", "Mexidol", "Prospekta", "Cerebrolysin"])
    def test_a_brand_with_no_generic_beside_it_is_left_alone(self, raw):
        """Supplying one would add information the registry never gave."""
        assert normalize_drug_name(raw) == raw


class TestEdges:
    @pytest.mark.parametrize("raw", [None, "", "   ", "+++"])
    def test_nothing_in_nothing_out(self, raw):
        assert normalize_drug_name(raw) is None

    def test_normalisation_is_idempotent(self):
        for raw in ("Atorvastatin 40 Mg Oral Tablet", "aspirin", "BAC treatment"):
            once = normalize_drug_name(raw)
            assert normalize_drug_name(once) == once


class TestCaseFold:
    def test_the_most_frequent_spelling_wins(self):
        names = ["Isosorbide mononitrate"] * 3 + ["Isosorbide Mononitrate"]
        assert fold_case_variants(names) == {
            "Isosorbide mononitrate": "Isosorbide mononitrate",
            "Isosorbide Mononitrate": "Isosorbide mononitrate",
        }

    def test_a_tie_is_broken_by_sort_order_rather_than_by_iteration_order(self):
        forward = fold_case_variants(["Abc", "abc"])
        backward = fold_case_variants(["abc", "Abc"])
        assert forward == backward

    def test_names_that_differ_by_more_than_case_are_left_apart(self):
        folded = fold_case_variants(["Choline Alfoscerate", "Choline alphoscerate"])
        assert folded["Choline Alfoscerate"] == "Choline Alfoscerate"
        assert folded["Choline alphoscerate"] == "Choline alphoscerate"
