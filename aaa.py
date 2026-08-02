import json

raw_divisions = [
    {
        "age_group": "Pupils 1",
        "birth_years": {"min": 2018, "max": 2019},
        "male_weights": [18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38],
        "female_weights": [18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38],
    },
    {
        "age_group": "Pupils 2",
        "birth_years": {"min": 2016, "max": 2017},
        "male_weights": [22, 24, 26, 28, 30, 32, 34, 36, 38, 41, 44],
        "female_weights": [22, 24, 26, 28, 30, 32, 34, 36, 38, 41, 44],
    },
    {
        "age_group": "Younger Cadets",
        "birth_years": {"min": 2014, "max": 2015},
        "male_weights": [26, 28, 30, 32, 34, 36, 39, 42, 46, 50, 55],
        "female_weights": [26, 28, 30, 32, 34, 36, 39, 42, 46, 50, 55],
    },
    {
        "age_group": "Cadets",
        "birth_years": {"min": 2011, "max": 2013},
        "male_weights": [33, 37, 41, 45, 49, 53, 57, 61, 65],
        "female_weights": [29, 33, 37, 41, 44, 47, 51, 55, 59],
    },
    {
        "age_group": "Juniors",
        "birth_years": {"min": 2008, "max": 2010},
        "male_weights": [45, 48, 51, 55, 59, 63, 68, 73, 78],
        "female_weights": [42, 44, 46, 49, 52, 55, 59, 63, 68],
    },
    {
        "age_group": "Seniors",
        "birth_years": {"min": 1991, "max": 2008},
        "male_weights": [54, 58, 63, 68, 74, 80, 87],
        "female_weights": [46, 49, 53, 57, 62, 67, 73],
    },
    {
        "age_group": "Veterans",
        "birth_years": {"min": 1960, "max": 1990},
        "male_weights": [54, 58, 63, 68, 74, 80, 87],
        "female_weights": [46, 49, 53, 57, 62, 67, 73],
    },
]

categories = {}

for div in raw_divisions:
    age_title = f"{div['age_group']} ({div['birth_years']['min']}-{div['birth_years']['max']})"
    
    for gender in ["Male", "Female"]:
        weights = div["male_weights"] if gender == "Male" else div["female_weights"]
        
        # Build weight brackets
        for i, max_w in enumerate(weights):
            min_w = 0.0 if i == 0 else weights[i-1] + 0.01
            code = f"kyorugi_{div['age_group'].lower().replace(' ', '_')}_{gender.lower()}_m{max_w}"
            
            categories[code] = {
                "id": code,
                "name": f"Kyorugi {div['age_group']} {gender} -{max_w}kg",
                "displayPath": ["Kyorugi", age_title, gender],
                "units": "kg",
                "criteria": [
                    {
                        "display": "Gender",
                        "field": "gender",
                        "operator": "EQUALS",
                        "value": gender.lower()
                    },
                    {
                        "display": "Birth Year",
                        "field": "birthday",
                        "calculation": "BIRTH_YEAR",
                        "operator": "BETWEEN",
                        "value": div["birth_years"]
                    },
                    {
                        "display": "Declared Weight",
                        "field": "__weight__",
                        "operator": "BETWEEN",
                        "value": {"min": min_w, "max": float(max_w)}
                    }
                ]
            }
        
        # Plus class (+MaxWeight)
        last_weight = weights[-1]
        plus_code = f"kyorugi_{div['age_group'].lower().replace(' ', '_')}_{gender.lower()}_p{last_weight}"
        categories[plus_code] = {
            "id": plus_code,
            "name": f"Kyorugi {div['age_group']} {gender} +{last_weight}kg",
            "displayPath": ["Kyorugi", age_title, gender],
            "criteria": [
                {
                    "display": "Gender",
                    "field": "gender",
                    "operator": "EQUALS",
                    "value": gender.lower()
                },
                {
                    "display": "Birth Year",
                    "field": "birthday",
                    "calculation": "BIRTH_YEAR",
                    "operator": "BETWEEN",
                    "value": div["birth_years"]
                },
                {
                    "display": "Declared Weight",
                    "field": "__weight__",
                    "operator": "GREATER_THAN_OR_EQUAL",
                    "value": float(last_weight) + 0.01
                }
            ]
        }

# Save output to JSON
with open("kyorugi_categories.json", "w") as f:
    json.dump({"categories": list(categories.values())}, f, indent=2)

print(f"Generated {len(categories)} categories standard JSON.")